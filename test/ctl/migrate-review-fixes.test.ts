import { describe, expect, it } from "vitest";
import { applyPlan } from "../../tools/ctl/apply.js";
import { ConfigError, parseConfig, type ResolvedConfig } from "../../tools/ctl/config.js";
import type { Step } from "../../tools/ctl/isolation/index.js";
import { planMigrate, type Plan } from "../../tools/ctl/plan.js";
import { renderPlan } from "../../tools/ctl/render.js";
import { stepArgv } from "../../tools/ctl/shell.js";
import { FakeRunner, rawCfg, tmp } from "./helpers.js";

// Review fixes for planMigrate. Plans are data; apply runs through FakeRunner. Nothing here touches a host and none of the
// commands has been run on one (UNVERIFIED).

const OLD_HOME = "/home/tester/.paseo-people/ann";
const OLD_ENV = "/home/tester/.paseo-people/ann.env";
const WANTS = "/home/tester/.config/systemd/user/default.target.wants/paseo-ann.service";
const PID_GUARD = "ann.guard-old-daemon-stopped";

const target = (extra: Record<string, unknown> = {}) => ({
  name: "ann",
  isolation: "unix-account",
  unixAccount: "acct-ann",
  install: "separate",
  providers: ["claude"],
  port: 7150,
  ...extra,
});
const config = (extra: Record<string, unknown> = {}, people: Record<string, unknown>[] = [target()]): ResolvedConfig =>
  parseConfig(rawCfg({ paseoVersion: "0.17.4", people, ...extra }));

const idx = (p: Plan, id: string): number => {
  const i = p.steps.findIndex((s) => s.id === id);
  if (i < 0) throw new Error(`step ${id} is missing (ids: ${p.steps.map((x) => x.id).join(", ")})`);
  return i;
};
const find = (p: Plan, id: string): Step => p.steps[idx(p, id)] as Step;
const argvOf = (p: Plan, id: string): string[] => stepArgv(find(p, id)) ?? [];

describe("planMigrate refuses a source that is the operator's own home", () => {
  it("refuses when the old PASEO_HOME would be userHome itself (homeBase is the parent of userHome)", () => {
    const ctx = config({ userHome: "/home/ann", homeBase: "/home", unixAccountHomeBase: "/srv" });
    expect(() => planMigrate(ctx, "ann")).toThrow(ConfigError);
    expect(() => planMigrate(ctx, "ann")).toThrow(/userHome/);
  });

  it("refuses when the old PASEO_HOME would contain userHome", () => {
    const ctx = config({ userHome: "/srv/people/ann/deep", homeBase: "/srv/people", unixAccountHomeBase: "/home" });
    expect(() => planMigrate(ctx, "ann")).toThrow(ConfigError);
  });

  it("refuses when the old env file would be userHome itself", () => {
    const ctx = config({ userHome: "/srv/ann.env", homeBase: "/srv", unixAccountHomeBase: "/home" });
    expect(() => planMigrate(ctx, "ann")).toThrow(ConfigError);
  });

  it("still plans the normal layout (homeBase under userHome)", () => {
    expect(() => planMigrate(config(), "ann")).not.toThrow();
  });
});

describe("planMigrate: root preflight on the old layout, before anything is changed", () => {
  const plan = planMigrate(config(), "ann");
  const BEFORE = ["ann.useradd", "ann.lock-password", "ann.account-home", "ann.move-paseo-home", "ann.chown-paseo-home", "ann.carry-secret-env", "ann.enable"];
  const PREFLIGHT: [string, string[]][] = [
    ["ann.guard-old-home-link", ["test", "!", "-L", OLD_HOME]],
    ["ann.guard-old-home-dir", ["test", "-d", OLD_HOME]],
    ["ann.guard-old-env-link", ["test", "!", "-L", OLD_ENV]],
    ["ann.guard-old-env-file", ["test", "-f", OLD_ENV]],
    ["ann.guard-old-unit-disabled", ["test", "!", "-L", WANTS]],
    ["ann.guard-old-hardlinks", ["find", OLD_HOME, "!", "-type", "d", "-links", "+1", "-exec", "false", "{}", "+"]],
  ];

  it.each(PREFLIGHT)("%s is a privileged shell-free command, after the pid guard and before useradd and every change", (id, argv) => {
    const s = find(plan, id);
    expect(s.kind).toBe("command");
    expect(s.privileged).toBe(true);
    expect(argvOf(plan, id)).toEqual(argv);
    expect(s.description).toMatch(/UNVERIFIED/);
    expect(idx(plan, PID_GUARD)).toBeLessThan(idx(plan, id));
    for (const later of BEFORE) expect(idx(plan, id), `${id} before ${later}`).toBeLessThan(idx(plan, later));
  });

  it("the pid guard is still the first privileged step", () => {
    expect(plan.steps.filter((s) => s.privileged === true)[0]?.id).toBe(PID_GUARD);
  });

  it.each(PREFLIGHT)("root phase alone: when %s fails, no account, move, chown or copy runs", async (id) => {
    const out = await tmp();
    await renderPlan(plan, out);
    const failing = JSON.stringify(argvOf(plan, id));
    const runner = new FakeRunner((argv) => JSON.stringify(argv) === failing);
    const r = await applyPlan(plan, out, runner, { isRoot: true });
    expect(r.ok).toBe(false);
    expect(r.failed?.id).toBe(id);
    const ran = new Set(runner.calls.map((a) => JSON.stringify(a)));
    for (const later of BEFORE) expect(ran.has(JSON.stringify(argvOf(plan, later))), later).toBe(false);
  });

  it("no unprivileged step runs a preflight", () => {
    for (const [id] of PREFLIGHT) expect(find(plan, id).privileged).toBe(true);
  });
});

describe("planMigrate: preflight follows homeBase and userHome", () => {
  it("names the configured old paths", () => {
    const p = planMigrate(config({ homeBase: "/srv/old-people" }), "ann");
    expect(argvOf(p, "ann.guard-old-home-dir")).toEqual(["test", "-d", "/srv/old-people/ann"]);
    expect(argvOf(p, "ann.guard-old-env-file")).toEqual(["test", "-f", "/srv/old-people/ann.env"]);
    expect(argvOf(p, "ann.guard-old-unit-disabled")).toEqual(["test", "!", "-L", WANTS]);
  });
});
