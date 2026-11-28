import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyPlan, type CommandRunner } from "../../tools/ctl/apply.js";
import { ConfigError, parseConfig } from "../../tools/ctl/config.js";
import { personStepFilter, planForPerson, planHost, type Plan } from "../../tools/ctl/plan.js";
import { renderPlan } from "../../tools/ctl/render.js";
import { stepArgv } from "../../tools/ctl/shell.js";
import { FakeRunner, rawCfg, tmp } from "./helpers.js";

/**
 * Hardening of separate installs. Plans are data and apply runs through FakeRunner: nothing here touches a host.
 * Synthetic values only.
 */
const VERSION = "0.17.4";
const ACCT_HOME = "/home/acct-ann";
const ann = { name: "ann", isolation: "unix-account", unixAccount: "acct-ann", install: "separate", providers: ["claude"] };
const config = (extra: Record<string, unknown> = {}, people: Record<string, unknown>[] = [ann]) =>
  parseConfig(rawCfg({ paseoVersion: VERSION, people, ...extra }));

const underAcct = (p: string) => p === ACCT_HOME || p.startsWith(`${ACCT_HOME}/`);
const isNpm = (argv: string[]) => argv.includes("npm");
const isRootInstall = (argv: string[]) => argv[0] === "install";

describe("root never writes through paths the account controls", () => {
  const plan = planHost(config());
  const steps = planForPerson(plan, "ann").steps;

  it("no dir step is created by root inside the account home (the account creates them itself)", () => {
    const dirs = steps.filter((s) => s.kind === "dir").map((s) => s.dir?.path);
    expect(dirs.filter((p) => p !== undefined && p !== ACCT_HOME)).toEqual([]);
    // the account-owned directories still exist, made by the account
    for (const p of [".paseo-daemon", ".config", ".config/systemd", ".config/systemd/user", ".local", ".local/npm"]) {
      const made = steps.some((s) => s.command?.[0] === "runuser" && s.command.at(-1) === `${ACCT_HOME}/${p}` && s.command.includes("mkdir"));
      expect(made, p).toBe(true);
    }
  });

  it("apply: no root install runs after account code (npm) has run", async () => {
    const out = await tmp();
    await renderPlan(plan, out);
    const runner = new FakeRunner();
    const r = await applyPlan(plan, out, runner, { isRoot: true, only: personStepFilter(plan, "ann") });
    expect(r.ok).toBe(true);
    const firstNpm = runner.calls.findIndex(isNpm);
    expect(firstNpm).toBeGreaterThan(0);
    const lateRootInstall = runner.calls.slice(firstNpm).filter(isRootInstall);
    expect(lateRootInstall).toEqual([]);
    // and the root file writes did happen, before the installer
    const files = runner.calls.slice(0, firstNpm).filter(isRootInstall).map((a) => a.at(-1));
    expect(files).toEqual(expect.arrayContaining([`${ACCT_HOME}/.paseo-daemon.env`, `${ACCT_HOME}/.config/systemd/user/paseo-ann.service`]));
  });

  it("apply: a fake npm that swaps a parent for a symlink never gets a privileged write through it", async () => {
    const out = await tmp();
    await renderPlan(plan, out);
    let swapped = false;
    const reached: string[][] = [];
    const runner: CommandRunner = {
      async run(argv) {
        if (isNpm(argv)) swapped = true; // the installer replaces .config/systemd/user with a symlink
        else if (swapped && isRootInstall(argv) && underAcct(argv.at(-1) ?? "")) reached.push(argv);
        return { code: 0 };
      },
    };
    await applyPlan(plan, out, runner, { isRoot: true, only: personStepFilter(plan, "ann") });
    expect(reached).toEqual([]);
  });

  it("every root file install under the account home is preceded by a symlink guard on each parent and on the file", () => {
    const argvs = steps.map((s) => ({ id: s.id, argv: stepArgv(s) ?? [] }));
    for (const f of steps.filter((s) => s.kind === "file")) {
      const at = steps.indexOf(f);
      const before = argvs.slice(0, at).filter((x) => x.argv.includes("-L")).map((x) => x.argv.join(" "));
      const path = f.file?.path ?? "";
      const chain: string[] = [];
      for (let p = path; p !== ACCT_HOME && p !== "/"; p = p.slice(0, p.lastIndexOf("/"))) chain.push(p);
      for (const p of chain) expect(before.some((c) => c.endsWith(`test ! -L ${p}`)), `${f.id}: ${p}`).toBe(true);
    }
  });

  it("apply stops at a guard that finds a symlink, before any root install", async () => {
    const out = await tmp();
    await renderPlan(plan, out);
    const runner = new FakeRunner((argv) => argv.at(-2) === "-L" && argv.at(-1) === `${ACCT_HOME}/.config/systemd/user`);
    const r = await applyPlan(plan, out, runner, { isRoot: true, only: personStepFilter(plan, "ann") });
    expect(r.ok).toBe(false);
    // the account home itself (a child of a root-owned directory) is the only path root creates before the guards
    const written = runner.calls.filter(isRootInstall).map((a) => a.at(-1) ?? "");
    expect(written.filter((p) => underAcct(p) && p !== ACCT_HOME)).toEqual([]);
    expect(runner.calls.some(isNpm)).toBe(false);
  });

  it("the account home itself is still created by root, and a legacy unix-account person is unchanged", () => {
    expect(steps.find((s) => s.id === "ann.account-home")?.dir).toEqual({ path: ACCT_HOME, mode: "0700", owner: "acct-ann" });
    const legacy = planHost(parseConfig(rawCfg({ people: [{ name: "cy", isolation: "unix-account", unixAccount: "svc-cy" }] })));
    expect(legacy.steps.filter((s) => s.kind === "dir").map((s) => s.id)).toEqual([
      "cy.account-home", "cy.paseo-home", "cy.config-dir", "cy.systemd-dir", "cy.unit-dir",
    ]);
  });
});

describe("a separate person's plan never names the operator's home", () => {
  const people = [ann, { name: "carl", acknowledge: ["shared-provider-history"] }];

  it("the serialized person plan, verify steps included, has no userHome", () => {
    const part = planForPerson(planHost(config({}, people)), "ann");
    expect(JSON.stringify(part)).not.toContain("/home/tester");
    // the check is still there, as a manual step that names no path
    const s = part.verify.find((x) => x.id === "ann.verify-operator-home");
    expect(s?.kind).toBe("manual");
  });

  it("neither plan.json nor apply.sh from a render carries it", async () => {
    const plan = planForPerson(planHost(config()), "ann");
    const out = await tmp();
    await renderPlan(plan, out);
    const files: string[] = [];
    for (const e of await readdir(out, { withFileTypes: true, recursive: true })) {
      if (e.isFile() && !e.parentPath.includes("secrets")) files.push(join(e.parentPath, e.name));
    }
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) expect(await readFile(f, "utf8"), f).not.toContain("/home/tester");
  });
});

describe("a neighbour whose home is also an environmentPath entry", () => {
  const mixed = () =>
    config({ homeBase: "/srv/people", environmentPath: "/srv/people/carl" }, [ann, { name: "carl", acknowledge: ["shared-provider-history"] }]);

  it("is not named in the separate person's plan", () => {
    const part = planForPerson(planHost(mixed()), "ann");
    expect(JSON.stringify(part)).not.toContain("/srv/people/carl");
  });

  it("a visible neighbour is checked through the scrubbed runuser wrapper, not sudo", () => {
    const part = planForPerson(planHost(config({ homeBase: "/srv/people" }, [ann, { name: "carl", acknowledge: ["shared-provider-history"] }])), "ann");
    const check = part.verify.find((s) => s.id === "ann.carl.verify-unreadable-from-account");
    expect(check?.command).toEqual([
      "runuser", "-u", "acct-ann", "--", "env", "-i", `HOME=${ACCT_HOME}`, "PATH=/usr/local/bin:/usr/bin:/bin",
      "test", "!", "-r", "/srv/people/carl",
    ]);
    for (const s of [...part.steps, ...part.verify]) expect(s.command?.[0], s.id).not.toBe("sudo");
  });
});

describe("environmentPath cannot escape the operator's home", () => {
  const withPath = (environmentPath: string) => () => config({ environmentPath });

  it("rejects a %h entry that climbs out with ..", () => {
    expect(withPath("%h/../acct-ann/.local/npm/bin")).toThrow(ConfigError);
  });

  it("rejects .. and . segments anywhere", () => {
    expect(withPath("/opt/tools/../../home/acct-ann/.local/npm/bin")).toThrow(ConfigError);
    expect(withPath("%h/bin/..")).toThrow(ConfigError);
    expect(withPath("%h/./bin")).toThrow(ConfigError);
  });

  it("still accepts ordinary entries and dotted names", () => {
    expect(withPath("%h/bin")).not.toThrow();
    expect(withPath("%h/.local/npm/bin:/opt/tools/bin")).not.toThrow();
    expect(withPath("%h/..hidden/v1.2")).not.toThrow();
  });
});

describe("plan stays a description", () => {
  it("no step of a separate person is a shell string", () => {
    const part: Plan = planForPerson(planHost(config()), "ann");
    for (const s of [...part.steps, ...part.verify]) {
      for (const x of stepArgv(s) ?? []) expect(["sh", "bash", "-c"].includes(x), s.id).toBe(false);
    }
  });
});
