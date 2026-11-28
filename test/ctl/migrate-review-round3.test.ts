import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError, parseConfig, type ResolvedConfig } from "../../tools/ctl/config.js";
import { planMigrate, type Plan } from "../../tools/ctl/plan.js";
import { stepArgv } from "../../tools/ctl/shell.js";
import { sandbox, writeJson, type Sandbox } from "./cli-helpers.js";
import { BASE, FakeRunner } from "./helpers.js";

// Review round 3 for planMigrate and `migrate`. Plans are data; apply runs through FakeRunner and nothing here touches a
// host. None of the commands has been run on a real host (UNVERIFIED).

const YES = ["--yes", "--i-understand-this-changes-the-host"];
const target = (extra: Record<string, unknown> = {}) => ({
  name: "ann",
  isolation: "unix-account",
  unixAccount: "acct-ann",
  install: "separate",
  providers: ["claude", "codex"],
  port: 7150,
  ...extra,
});
const raw = (people: Record<string, unknown>[] = [target()]) => ({ ...BASE, paseoVersion: "0.17.4", people });
const config = (): ResolvedConfig => parseConfig(raw());

/** Replaces the one person of a valid resolved config, the way a programmatic caller with a hand-built config could. */
const withPerson = (change: Record<string, unknown>): ResolvedConfig => {
  const c = config();
  return { ...c, people: c.people.map((p) => ({ ...p, ...change })) } as ResolvedConfig;
};

describe("finding 1: planMigrate checks a hand-built config the way parseConfig does", () => {
  it("accepts the valid config (control)", () => {
    expect(planMigrate(config(), "ann").steps.length).toBeGreaterThan(5);
  });

  it("refuses the root account, which parseConfig also refuses", () => {
    expect(() => parseConfig(raw([target({ unixAccount: "root" })]))).toThrow(ConfigError);
    expect(() => planMigrate(withPerson({ unixAccount: "root" }), "ann")).toThrow(ConfigError);
    expect(() => planMigrate(withPerson({ unixAccount: "root" }), "ann")).toThrow(/root/);
  });

  it("refuses a missing or non-portable account name", () => {
    expect(() => planMigrate(withPerson({ unixAccount: undefined }), "ann")).toThrow(ConfigError);
    for (const bad of ["Acct Ann", "acct;ann", "-acct", ""]) {
      expect(() => planMigrate(withPerson({ unixAccount: bad }), "ann"), bad).toThrow(ConfigError);
    }
  });

  it("refuses duplicate providers, which parseConfig also refuses", () => {
    expect(() => parseConfig(raw([target({ providers: ["claude", "claude"] })]))).toThrow(ConfigError);
    expect(() => planMigrate(withPerson({ providers: ["claude", "claude"] }), "ann")).toThrow(ConfigError);
    expect(() => planMigrate(withPerson({ providers: ["claude", "claude"] }), "ann")).toThrow(/duplicate provider/);
  });
});

// ---- findings 2 and 3 go through the CLI ----

async function stored(): Promise<Sandbox> {
  const s = await sandbox();
  await writeJson(s.configFile, raw());
  return s;
}
const expectedPlan = (): Plan => planMigrate(config(), "ann");
const argvOf = (id: string): string[] => {
  const step = expectedPlan().steps.find((x) => x.id === id);
  if (!step) throw new Error(`step ${id} is missing`);
  return stepArgv(step) ?? [];
};
const OLD_UNIT = "paseo-ann.service";

describe("finding 2: a failed root preflight says what is left and how to bring the old daemon back", () => {
  async function failAt(id: string) {
    const s = await stored();
    await s.run(["migrate", "ann"]);
    const failing = JSON.stringify(argvOf(id));
    const runner = new FakeRunner((a) => JSON.stringify(a) === failing);
    const r = await s.run(["migrate", "ann", "--apply", ...YES], { isRoot: () => true, runner });
    return { r, runner, s };
  }

  for (const id of ["ann.guard-old-parents", "ann.guard-old-hardlinks", "ann.guard-old-port", "ann.guard-old-env-file"]) {
    it(`${id}: says nothing was changed, that the stop already ran, and the command to re-enable the old unit`, async () => {
      const { r, runner } = await failAt(id);
      expect(r.code).toBe(1);
      expect(r.err).toContain(`FAILED at ${id}`);
      expect(r.err).toContain("ann.stop-shared");
      expect(r.err).toContain(`systemctl --user enable --now ${OLD_UNIT}`);
      expect(r.err).toMatch(/nothing .*changed/i);
      expect(r.err).toMatch(/safe to run .*again|run (it|this command) again/i);
      expect(r.err).not.toMatch(/not resumable/i);
      expect(r.err).not.toMatch(/already moved/);
      expect(runner.calls.at(-1)).toEqual(argvOf(id));
    });
  }

  it("a failure after the move keeps the existing not-resumable report", async () => {
    const { r } = await failAt("ann.install-paseo");
    expect(r.err).toMatch(/already moved/);
    expect(r.err).toMatch(/not resumable/);
  });

  it("an ordinary apply of a host plan does not mention the shared unit", async () => {
    const s = await sandbox();
    await writeJson(s.configFile, { ...BASE, people: [{ name: "ann", acknowledge: ["shared-provider-history"] }, { name: "bob", acknowledge: ["shared-provider-history"] }] });
    await s.run(["render"]);
    const runner = new FakeRunner((a) => a[0] === "systemctl");
    const r = await s.run(["apply", "ann", ...YES], { isRoot: () => false, runner });
    expect(r.code).toBe(1);
    expect(r.err).not.toContain("enable --now");
  });
});

describe("finding 3: migrate --apply applies only a plan that was rendered and reviewed", () => {
  it("refuses, renders, and runs nothing when nothing was rendered before", async () => {
    const s = await stored();
    const r = await s.run(["migrate", "ann", "--apply", ...YES], { isRoot: () => true });
    expect(r.code, r.err).toBe(2);
    expect(r.err).toMatch(/refusing/);
    expect(r.err).toMatch(/nothing was rendered|Read .*apply\.sh/);
    expect(s.runner.calls).toEqual([]);
    // It rendered, so the next run can be compared with what you read.
    expect(await readdir(join(s.stateRoot, "migrate-ann"))).toContain("plan.json");
  });

  it("applies when the stored plan is the one that was rendered", async () => {
    const s = await stored();
    expect((await s.run(["migrate", "ann"])).code).toBe(0);
    const r = await s.run(["migrate", "ann", "--apply", ...YES], { isRoot: () => true });
    expect(r.code, r.err).toBe(0);
    expect(s.runner.calls.length).toBeGreaterThan(5);
  });

  for (const [what, change] of [
    ["port", { port: 7151 }],
    ["providers", { providers: ["claude"] }],
    ["unixAccount", { unixAccount: "acct-ann2" }],
  ] as const) {
    it(`refuses with exit 2 and runs nothing when the ${what} changed after the review`, async () => {
      const s = await stored();
      expect((await s.run(["migrate", "ann"])).code).toBe(0);
      await writeJson(s.configFile, raw([target(change)]));
      const r = await s.run(["migrate", "ann", "--apply", ...YES], { isRoot: () => true });
      expect(r.code, r.err).toBe(2);
      expect(r.err).toMatch(/out of date/);
      expect(s.runner.calls).toEqual([]);
      // The new plan is rendered for review, and the old apply.sh is gone from under the reviewer.
      const rendered = JSON.parse(await readFile(join(s.stateRoot, "migrate-ann", "plan.json"), "utf8")) as Plan;
      expect(JSON.stringify(rendered.people[0])).toContain(Object.values(change)[0] as string);
      // The next run applies what was just rendered.
      const again = await s.run(["migrate", "ann", "--apply", ...YES], { isRoot: () => true });
      expect(again.code, again.err).toBe(0);
    });
  }

  it("refuses when the homeBase changed after the review", async () => {
    const s = await stored();
    expect((await s.run(["migrate", "ann"])).code).toBe(0);
    await writeJson(s.configFile, { ...raw(), homeBase: "/srv/other-people" });
    const r = await s.run(["migrate", "ann", "--apply", ...YES], { isRoot: () => true });
    expect(r.code, r.err).toBe(2);
    expect(s.runner.calls).toEqual([]);
  });

  it("without --apply it still renders every time", async () => {
    const s = await stored();
    expect((await s.run(["migrate", "ann"])).code).toBe(0);
    await writeJson(s.configFile, raw([target({ providers: ["claude"] })]));
    expect((await s.run(["migrate", "ann"])).code).toBe(0);
    expect(s.runner.calls).toEqual([]);
  });
});
