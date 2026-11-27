import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyPlan, ApplyRefused } from "../../tools/ctl/apply.js";
import { ConfigError, parseConfig } from "../../tools/ctl/config.js";
import { personStepFilter, planForPerson, planHost, type Plan } from "../../tools/ctl/plan.js";
import { renderPlan } from "../../tools/ctl/render.js";
import { stepArgv } from "../../tools/ctl/shell.js";
import type { Step } from "../../tools/ctl/isolation/index.js";
import { FakeRunner, rawCfg, tmp } from "./helpers.js";

/** Regression tests for the reviewed findings on separate installs. Synthetic values only; nothing runs on a host. */
const VERSION = "0.17.4";
const ann = {
  name: "ann",
  isolation: "unix-account",
  unixAccount: "acct-ann",
  install: "separate",
  providers: ["claude"],
};
const carl = { name: "carl", acknowledge: ["shared-provider-history"] };
const mixed = () => parseConfig(rawCfg({ paseoVersion: VERSION, people: [ann, carl] }));

/** Every string a step carries. */
const stepText = (s: Step): string =>
  [s.id, s.description, ...(stepArgv(s) ?? []), s.dir?.path, s.file?.path, s.file?.content]
    .filter((x): x is string => typeof x === "string")
    .join("\n");

async function renderedFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (e.isFile()) out.push(join(e.parentPath, e.name));
  }
  return out;
}

describe("a separate person's part of a mixed plan carries no operator paths", () => {
  const whole = planHost(mixed());
  const annPlan = planForPerson(whole, "ann");
  // The one hand-run check that names userHome on purpose: the account must not read it.
  const isHomeCheck = (s: Step) => s.id === "ann.verify-operator-home";

  it("has no same-user prerequisites and none of the neighbour's paths", () => {
    expect(annPlan.steps.filter((s) => s.id.startsWith("same-user."))).toEqual([]);
    for (const s of [...annPlan.steps, ...annPlan.verify].filter((x) => !isHomeCheck(x))) {
      expect(stepText(s), s.id).not.toContain("/home/tester");
    }
  });

  it("has no check against the same-user neighbour's PASEO_HOME", () => {
    expect(annPlan.verify.some((s) => s.id.startsWith("ann.carl."))).toBe(false);
    // the account-to-operator-home check still covers it
    expect(annPlan.verify.some(isHomeCheck)).toBe(true);
  });

  it("the same-user person keeps their prerequisites", () => {
    const carlPlan = planForPerson(whole, "carl");
    expect(carlPlan.steps.some((s) => s.id === "same-user.homebase")).toBe(true);
  });

  it("an unprivileged apply of the separate person hands no command to the runner", async () => {
    const out = await tmp();
    await renderPlan(whole, out);
    const runner = new FakeRunner();
    const r = await applyPlan(whole, out, runner, { isRoot: false, only: personStepFilter(whole, "ann") });
    expect(runner.calls).toEqual([]);
    expect(r.executed).toEqual([]);
  });

  it("a root apply of the separate person runs only the person's own steps", async () => {
    const out = await tmp();
    await renderPlan(whole, out);
    const runner = new FakeRunner();
    await applyPlan(whole, out, runner, { isRoot: true, only: personStepFilter(whole, "ann") });
    expect(runner.calls.length).toBeGreaterThan(0);
    for (const argv of runner.calls) expect(argv.join(" ")).not.toContain("/home/tester/.");
  });
});

describe("apply refuses a staged file that no longer matches the plan", () => {
  async function rendered(): Promise<{ plan: Plan; out: string; unit: string }> {
    const plan = planHost(mixed());
    const out = await tmp();
    await renderPlan(plan, out);
    const unit = (await renderedFiles(join(out, "files"))).find((f) => f.endsWith("paseo-ann.service") || /ann.*\.service$/.test(f));
    if (!unit) throw new Error("no staged ann unit");
    return { plan, out, unit };
  }

  it("refuses before any command when the staged unit was edited after render", async () => {
    const { plan, out, unit } = await rendered();
    const text = await readFile(unit, "utf8");
    expect(text).toMatch(/ExecStart=/);
    await writeFile(unit, text.replace(/^ExecStart=.*$/m, "ExecStart=/opt/evil"));
    const runner = new FakeRunner();
    await expect(applyPlan(plan, out, runner, { isRoot: true })).rejects.toBeInstanceOf(ApplyRefused);
    expect(runner.calls).toEqual([]);
  });

  it("refuses a tampered file even in the other phase's run", async () => {
    const { plan, out, unit } = await rendered();
    await writeFile(unit, "tampered\n");
    const runner = new FakeRunner();
    await expect(applyPlan(plan, out, runner, { isRoot: false })).rejects.toThrow(/does not match|render again/);
    expect(runner.calls).toEqual([]);
  });

  it("still applies an untouched render", async () => {
    const { plan, out } = await rendered();
    const runner = new FakeRunner();
    const r = await applyPlan(plan, out, runner, { isRoot: true });
    expect(r.ok).toBe(true);
  });
});

describe("a separate account home must not hold the host paseo binary or an operator PATH directory", () => {
  const fails = (extra: Record<string, unknown>, re: RegExp) => {
    const run = () => parseConfig(rawCfg({ paseoVersion: VERSION, people: [{ ...ann, unixAccount: "paseo" }], ...extra }));
    expect(run).toThrow(ConfigError);
    expect(run).toThrow(re);
  };

  it("rejects an account home that contains the host paseoBinary", () => {
    fails({ unixAccountHomeBase: "/opt" }, /paseoBinary/);
  });

  it("rejects an account home that contains an absolute environmentPath entry", () => {
    fails({ unixAccountHomeBase: "/opt/tools", environmentPath: "/usr/bin:/opt/tools/paseo/bin" }, /environmentPath/);
  });

  it("ignores %h entries and unrelated directories", () => {
    expect(() =>
      parseConfig(rawCfg({ paseoVersion: VERSION, environmentPath: "%h/bin:/usr/local/bin", people: [ann] })),
    ).not.toThrow();
  });

  it("does not change a unix-account person without install", () => {
    expect(() =>
      parseConfig(rawCfg({ unixAccountHomeBase: "/opt", people: [{ name: "cy", isolation: "unix-account", unixAccount: "paseo" }] })),
    ).not.toThrow();
  });
});

describe("account-level commands run with a scrubbed environment", () => {
  const plan = planHost(mixed());
  const account = [...plan.steps, ...plan.verify].filter((s) => s.command?.[0] === "runuser");

  it("uses env -i, so only HOME and PATH reach the account's command", () => {
    expect(account.length).toBeGreaterThan(0);
    for (const s of account) {
      expect(s.command?.slice(0, 5), s.id).toEqual(["runuser", "-u", "acct-ann", "--", "env"]);
      expect(s.command?.[5], s.id).toBe("-i");
      expect(s.command?.[6], s.id).toBe("HOME=/home/acct-ann");
      expect(s.command?.[7], s.id).toBe("PATH=/usr/local/bin:/usr/bin:/bin");
      // the next argument is the command itself, never another variable assignment
      expect(s.command?.[8], s.id).not.toMatch(/=/);
    }
  });
});
