import { mkdir, stat, symlink } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyPlan } from "../../tools/ctl/apply.js";
import { ConfigError, parseConfig, type ResolvedConfig } from "../../tools/ctl/config.js";
import type { Step } from "../../tools/ctl/isolation/index.js";
import { planMigrate, type Plan } from "../../tools/ctl/plan.js";
import { renderPlan } from "../../tools/ctl/render.js";
import { stepArgv } from "../../tools/ctl/shell.js";
import { sandbox, writeJson, type Sandbox } from "./cli-helpers.js";
import { BASE, FakeRunner, rawCfg, tmp } from "./helpers.js";

// Review round 2 for planMigrate and `migrate`. Plans are data; apply runs through FakeRunner and nothing here touches a
// host. None of the commands has been run on a real host (UNVERIFIED).

const YES = ["--yes", "--i-understand-this-changes-the-host"];
const PID_GUARD = "ann.guard-old-daemon-stopped";
const OLD_UNIT_FILE = "/home/tester/.config/systemd/user/paseo-ann.service";
const BEFORE_HOST_CHANGES = ["ann.useradd", "ann.lock-password", "ann.account-home", "ann.move-paseo-home", "ann.chown-paseo-home", "ann.carry-secret-env", "ann.enable"];

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

/** The root phase alone with `id` failing: nothing that changes the host may run afterwards. */
async function expectStopsBeforeHost(plan: Plan, id: string) {
  const out = await tmp();
  await renderPlan(plan, out);
  const failing = JSON.stringify(argvOf(plan, id));
  const runner = new FakeRunner((argv) => JSON.stringify(argv) === failing);
  const r = await applyPlan(plan, out, runner, { isRoot: true });
  expect(r.ok).toBe(false);
  expect(r.failed?.id).toBe(id);
  const ran = new Set(runner.calls.map((a) => JSON.stringify(a)));
  for (const later of BEFORE_HOST_CHANGES) expect(ran.has(JSON.stringify(argvOf(plan, later))), later).toBe(false);
}

describe("finding 1: a symlink in a parent directory of the old layout", () => {
  it("has a privileged find preflight over every parent directory, with no shell", () => {
    const plan = planMigrate(config({ homeBase: "/srv/old", unixAccountHomeBase: "/srv/new" }), "ann");
    const s = find(plan, "ann.guard-old-parents");
    expect(s.kind).toBe("command");
    expect(s.privileged).toBe(true);
    expect(s.description).toMatch(/UNVERIFIED/);
    expect(argvOf(plan, "ann.guard-old-parents")).toEqual(["find", "/srv", "/srv/old", "-maxdepth", "0", "-type", "l", "-exec", "false", "{}", "+"]);
  });

  it("covers the default layout up to the top, but never the root directory", () => {
    const argv = argvOf(planMigrate(config(), "ann"), "ann.guard-old-parents");
    expect(argv.slice(1, 4)).toEqual(["/home", "/home/tester", "/home/tester/.paseo-people"]);
    expect(argv).not.toContain("/");
  });

  it("runs after the pid guard and before the account exists", () => {
    const plan = planMigrate(config({ homeBase: "/srv/old", unixAccountHomeBase: "/srv/new" }), "ann");
    expect(idx(plan, PID_GUARD)).toBeLessThan(idx(plan, "ann.guard-old-parents"));
    for (const later of BEFORE_HOST_CHANGES) expect(idx(plan, "ann.guard-old-parents"), later).toBeLessThan(idx(plan, later));
  });

  it("a symlinked homeBase (the check fails) stops the root phase before useradd", async () => {
    const plan = planMigrate(config({ userHome: "/home/ann", homeBase: "/srv/old", unixAccountHomeBase: "/srv/new" }), "ann");
    await expectStopsBeforeHost(plan, "ann.guard-old-parents");
  });
});

describe("finding 2: --out inside the data being moved", () => {
  async function stored(): Promise<{ s: Sandbox; userHome: string; oldHome: string; oldEnv: string }> {
    const s = await sandbox();
    const userHome = join(s.root, "operator");
    await writeJson(s.configFile, { ...BASE, userHome, paseoVersion: "0.17.4", people: [target()] });
    return { s, userHome, oldHome: join(userHome, ".paseo-people", "ann"), oldEnv: join(userHome, ".paseo-people", "ann.env") };
  }
  const exists = (p: string) => stat(p).then(() => true, () => false);

  it("refuses an --out below the old PASEO_HOME: exit 2, nothing rendered, nothing run", async () => {
    const { s, oldHome } = await stored();
    const out = join(oldHome, "review");
    const r = await s.run(["migrate", "ann", "--out", out]);
    expect(r.code, r.err).toBe(2);
    expect(r.err).toContain(oldHome);
    expect(s.runner.calls).toEqual([]);
    expect(await exists(oldHome)).toBe(false);
  });

  it("refuses an --out that is the old PASEO_HOME, even with --apply", async () => {
    const { s, oldHome } = await stored();
    const r = await s.run(["migrate", "ann", "--out", oldHome, "--apply", ...YES], { isRoot: () => true });
    expect(r.code, r.err).toBe(2);
    expect(s.runner.calls).toEqual([]);
  });

  it("refuses an --out that is the old env file", async () => {
    const { s, oldEnv } = await stored();
    const r = await s.run(["migrate", "ann", "--out", oldEnv]);
    expect(r.code, r.err).toBe(2);
    expect(s.runner.calls).toEqual([]);
  });

  it("refuses an --out reached through a symbolic link into the old PASEO_HOME", async () => {
    const { s, oldHome } = await stored();
    await mkdir(oldHome, { recursive: true });
    const link = join(s.root, "link");
    await symlink(oldHome, link);
    const r = await s.run(["migrate", "ann", "--out", join(link, "review")]);
    expect(r.code, r.err).toBe(2);
    expect(await exists(join(oldHome, "review"))).toBe(false);
    expect(s.runner.calls).toEqual([]);
  });

  it("refuses a default render directory that would lie under the old PASEO_HOME", async () => {
    const { s, userHome } = await stored();
    // XDG_STATE_HOME inside the old PASEO_HOME makes the default directory <old>/.../migrate-ann.
    const inside = join(userHome, ".paseo-people", "ann", "state");
    const r = await s.run(["migrate", "ann"], { env: { ...s.env, xdgStateHome: inside } });
    expect(r.code, r.err).toBe(2);
    expect(await exists(inside)).toBe(false);
  });

  it("still accepts an --out beside the old layout", async () => {
    const { s } = await stored();
    const out = join(s.root, "review");
    const r = await s.run(["migrate", "ann", "--out", out]);
    expect(r.code, r.err).toBe(0);
    expect(await exists(join(out, "plan.json"))).toBe(true);
  });
});

describe("finding 3: operator paths inside the source that is moved", () => {
  const base = { homeBase: "/srv/people", unixAccountHomeBase: "/srv/accts" };

  it("refuses a paseoBinary inside the old PASEO_HOME", () => {
    const ctx = config({ ...base, paseoBinary: "/srv/people/ann/bin/paseo" });
    expect(() => planMigrate(ctx, "ann")).toThrow(ConfigError);
    expect(() => planMigrate(ctx, "ann")).toThrow(/paseoBinary/);
  });

  it("refuses an absolute environmentPath entry inside the old PASEO_HOME", () => {
    const ctx = config({ ...base, environmentPath: "/srv/people/ann/bin:/usr/bin" });
    expect(() => planMigrate(ctx, "ann")).toThrow(ConfigError);
    expect(() => planMigrate(ctx, "ann")).toThrow(/environmentPath/);
  });

  it("refuses a %h environmentPath entry that expands to a directory inside the old PASEO_HOME", () => {
    const ctx = config({ environmentPath: "%h/.paseo-people/ann/bin:/usr/bin" });
    expect(() => planMigrate(ctx, "ann")).toThrow(ConfigError);
    expect(() => planMigrate(ctx, "ann")).toThrow(/environmentPath/);
  });

  it("refuses the old PASEO_HOME itself as the paseoBinary or as a PATH entry", () => {
    expect(() => planMigrate(config({ ...base, paseoBinary: "/srv/people/ann" }), "ann")).toThrow(ConfigError);
    expect(() => planMigrate(config({ ...base, environmentPath: "/srv/people/ann" }), "ann")).toThrow(ConfigError);
  });

  it("does not refuse a binary or PATH entry that is only beside or above the old PASEO_HOME", () => {
    expect(() => planMigrate(config({ ...base, paseoBinary: "/srv/people/ann-tools/paseo", environmentPath: "/srv/people:/srv/people/bob/bin" }), "ann")).not.toThrow();
  });
});

describe("finding 4: planMigrate fails with ConfigError on a bad ResolvedConfig", () => {
  const withoutVersion = (): ResolvedConfig => {
    const { paseoVersion: _omit, ...rest } = config();
    return rest;
  };
  const withPerson = (patch: Record<string, unknown>): ResolvedConfig => {
    const c = config();
    return { ...c, people: c.people.map((p) => ({ ...p, ...patch })) as ResolvedConfig["people"] };
  };

  it("missing paseoVersion", () => {
    expect(() => planMigrate(withoutVersion(), "ann")).toThrow(ConfigError);
    expect(() => planMigrate(withoutVersion(), "ann")).toThrow(/paseoVersion/);
  });

  it("a version that is not exact", () => {
    for (const v of ["latest", "^0.17.4", "0.17"]) expect(() => planMigrate({ ...config(), paseoVersion: v }, "ann"), v).toThrow(ConfigError);
  });

  it("an unknown provider", () => {
    const ctx = withPerson({ providers: ["nope"] });
    expect(() => planMigrate(ctx, "ann")).toThrow(ConfigError);
    expect(() => planMigrate(ctx, "ann")).toThrow(/unknown provider "nope"/);
  });

  it("an empty provider list", () => {
    expect(() => planMigrate(withPerson({ providers: [] }), "ann")).toThrow(ConfigError);
  });

  it("a person who is not unix-account, or has no separate install", () => {
    expect(() => planMigrate(withPerson({ isolation: "same-user" }), "ann")).toThrow(ConfigError);
    const noInstall = config({}, [{ name: "ann", isolation: "unix-account", unixAccount: "acct-ann" }, target({ name: "bob", unixAccount: "acct-bob", port: 7160 })]);
    expect(() => planMigrate(noInstall, "ann")).toThrow(ConfigError);
  });
});

describe("finding 5: homeBase equal to userHome", () => {
  it("refuses: the source would be an ordinary directory in the operator's home", () => {
    const ctx = config({ homeBase: "/home/tester" });
    expect(ctx.homeBase).toBe(ctx.userHome);
    expect(() => planMigrate(ctx, "ann")).toThrow(ConfigError);
    expect(() => planMigrate(ctx, "ann")).toThrow(/homeBase/);
  });

  it("still plans the default homeBase", () => {
    expect(() => planMigrate(config(), "ann")).not.toThrow();
  });
});

describe("finding 6: the configured port must be the port the old unit listens on", () => {
  const LINE = "Environment=PASEO_LISTEN=127.0.0.1:7150";

  it("checks the old unit file for the exact listen line, as root, with no shell", () => {
    const plan = planMigrate(config(), "ann");
    const s = find(plan, "ann.guard-old-port");
    expect(s.kind).toBe("command");
    expect(s.privileged).toBe(true);
    expect(s.description).toMatch(/UNVERIFIED/);
    expect(argvOf(plan, "ann.guard-old-port")).toEqual(["grep", "-q", "-x", "-F", "-e", LINE, "--", OLD_UNIT_FILE]);
  });

  it("is the same listen line the new unit gets", () => {
    const plan = planMigrate(config(), "ann");
    expect(find(plan, "ann.unit").file?.content ?? "").toContain(`${LINE}\n`);
  });

  it("follows the listen address and port of the config", () => {
    const plan = planMigrate(config({ listenAddress: "10.1.2.3", userHome: "/home/tester" }, [target({ port: 7222 })]), "ann");
    expect(argvOf(plan, "ann.guard-old-port")).toContain("Environment=PASEO_LISTEN=10.1.2.3:7222");
  });

  it("comes before useradd and every change", () => {
    const plan = planMigrate(config(), "ann");
    expect(idx(plan, PID_GUARD)).toBeLessThan(idx(plan, "ann.guard-old-port"));
    for (const later of BEFORE_HOST_CHANGES) expect(idx(plan, "ann.guard-old-port"), later).toBeLessThan(idx(plan, later));
  });

  it("a different port in the old unit (grep fails) stops the root phase before useradd", async () => {
    await expectStopsBeforeHost(planMigrate(config(), "ann"), "ann.guard-old-port");
  });
});

describe("finding 7: a failure after the move says what state is left and what to run by hand", () => {
  async function stored(): Promise<Sandbox> {
    const s = await sandbox();
    await writeJson(s.configFile, { ...BASE, paseoVersion: "0.17.4", people: [target({ providers: ["claude", "codex"] })] });
    return s;
  }
  const failing = (id: string) => {
    const plan = planMigrate(config({}, [target({ providers: ["claude", "codex"] })]), "ann");
    const argv = JSON.stringify(argvOf(plan, id));
    return new FakeRunner((a) => JSON.stringify(a) === argv);
  };

  it("after the move: names the moved home, the steps that did not run, and apply.sh", async () => {
    const s = await stored();
    const runner = failing("ann.install-paseo");
    const r = await s.run(["migrate", "ann", "--apply", ...YES], { isRoot: () => true, runner });
    expect(r.code).toBe(1);
    expect(r.err).toContain("FAILED at ann.install-paseo");
    expect(r.err).toMatch(/already moved/);
    expect(r.err).toMatch(/not resumable|cannot be resumed|will not resume/i);
    expect(r.err).toContain(join(s.stateRoot, "migrate-ann", "apply.sh"));
    for (const id of ["ann.install-claude", "ann.install-codex", "ann.enable"]) expect(r.err, id).toContain(id);
    expect(r.err).not.toContain("ann.useradd");
  });

  it("a rerun stops at the old-home guard and the output explains why", async () => {
    const s = await stored();
    const runner = failing("ann.guard-old-home-dir");
    const r = await s.run(["migrate", "ann", "--apply", ...YES], { isRoot: () => true, runner });
    expect(r.code).toBe(1);
    expect(r.err).toContain("FAILED at ann.guard-old-home-dir");
    expect(r.err).toMatch(/already migrated/);
    expect(r.err).not.toMatch(/already moved/);
  });
});
