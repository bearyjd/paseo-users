import { chmod, lstat, mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyPlan } from "../../tools/ctl/apply.js";
import { ConfigError, parseConfig, type ResolvedConfig } from "../../tools/ctl/config.js";
import type { Step } from "../../tools/ctl/isolation/index.js";
import { planMigrate, type Plan } from "../../tools/ctl/plan.js";
import { renderApplyScript, renderPlan } from "../../tools/ctl/render.js";
import { stepArgv } from "../../tools/ctl/shell.js";
import { sandbox, writeJson, type Sandbox } from "./cli-helpers.js";
import { BASE, FakeRunner, tmp } from "./helpers.js";

// Review round 4 for planMigrate and `migrate`. Plans are data; apply runs through FakeRunner and nothing here touches a
// host. None of the commands has been run on a real host (UNVERIFIED). Synthetic values only.

const YES = ["--yes", "--i-understand-this-changes-the-host"];
const OLD_UNIT = "paseo-ann.service";
const OLD_UNIT_FILE = "/home/tester/.config/systemd/user/paseo-ann.service";

const target = (extra: Record<string, unknown> = {}) => ({
  name: "ann",
  isolation: "unix-account",
  unixAccount: "acct-ann",
  install: "separate",
  providers: ["claude"],
  port: 7150,
  ...extra,
});
const raw = (extra: Record<string, unknown> = {}) => ({ ...BASE, paseoVersion: "0.17.4", people: [target()], ...extra });
const config = (extra: Record<string, unknown> = {}): ResolvedConfig => parseConfig(raw(extra));
/** A hand-built config: a valid resolved one with top-level fields replaced, the way a library caller could. */
const handBuilt = (change: Partial<ResolvedConfig>): ResolvedConfig => ({ ...config(), ...change });
const withPerson = (change: Record<string, unknown>): ResolvedConfig => {
  const c = config();
  return { ...c, people: c.people.map((p) => ({ ...p, ...change })) } as ResolvedConfig;
};

const find = (p: Plan, id: string): Step => {
  const s = p.steps.find((x) => x.id === id);
  if (!s) throw new Error(`step ${id} is missing (ids: ${p.steps.map((x) => x.id).join(", ")})`);
  return s;
};
const argvOf = (p: Plan, id: string): string[] => stepArgv(find(p, id)) ?? [];
const idx = (p: Plan, id: string): number => p.steps.findIndex((s) => s.id === id);
const exists = (p: string) => stat(p).then(() => true, () => false);

async function stored(extra: Record<string, unknown> = {}): Promise<Sandbox> {
  const s = await sandbox();
  await writeJson(s.configFile, raw(extra));
  return s;
}

describe("finding 1: the render directory must not hold the data migrate moves", () => {
  it("refuses, keeps the source data and the env file, and runs nothing, when homeBase is under <out>/files", async () => {
    const s = await sandbox();
    const out = join(s.root, "review");
    const homeBase = join(out, "files", "shared");
    await writeJson(s.configFile, raw({ homeBase }));
    // A reused render directory: it has a plan.json, so render would delete <out>/files.
    await mkdir(join(homeBase, "ann"), { recursive: true });
    await writeFile(join(out, "plan.json"), "{}\n");
    await writeFile(join(homeBase, "ann", "data.txt"), "synthetic session data");
    await writeFile(join(homeBase, "ann.env"), "PASEO_PASSWORD=synthetic-test-value\n");

    const r = await s.run(["migrate", "ann", "--out", out]);
    expect(r.code, r.err).toBe(2);
    expect(r.err).toContain(out);
    expect(await readFile(join(homeBase, "ann", "data.txt"), "utf8")).toBe("synthetic session data");
    expect(await readFile(join(homeBase, "ann.env"), "utf8")).toBe("PASEO_PASSWORD=synthetic-test-value\n");
    expect(s.runner.calls).toEqual([]);

    const applied = await s.run(["migrate", "ann", "--out", out, "--apply", ...YES], { isRoot: () => true });
    expect(applied.code, applied.err).toBe(2);
    expect(await exists(join(homeBase, "ann", "data.txt"))).toBe(true);
    expect(s.runner.calls).toEqual([]);
  });

  it("refuses an --out that is a parent of the old layout, reached through a symbolic link too", async () => {
    const s = await sandbox();
    const real = join(s.root, "real");
    const homeBase = join(real, "people");
    await mkdir(join(homeBase, "ann"), { recursive: true });
    const link = join(s.root, "link");
    await symlink(real, link);
    await writeJson(s.configFile, raw({ homeBase }));
    const r = await s.run(["migrate", "ann", "--out", link]);
    expect(r.code, r.err).toBe(2);
    expect(await exists(join(homeBase, "ann"))).toBe(true);
  });
});

describe("finding 2 and 6: the old unit must use the paths the plan moves", () => {
  const HOME_GUARD = "ann.guard-old-unit-home";
  const ENV_GUARD = "ann.guard-old-unit-env";

  it("greps the old unit for the exact PASEO_HOME and EnvironmentFile lines, as one argv each", () => {
    const plan = planMigrate(config(), "ann");
    expect(argvOf(plan, HOME_GUARD)).toEqual(["grep", "-q", "-x", "-F", "-e", "Environment=PASEO_HOME=/home/tester/.paseo-people/ann", "--", OLD_UNIT_FILE]);
    expect(argvOf(plan, ENV_GUARD)).toEqual(["grep", "-q", "-x", "-F", "-e", "EnvironmentFile=/home/tester/.paseo-people/ann.env", "--", OLD_UNIT_FILE]);
    for (const id of [HOME_GUARD, ENV_GUARD]) {
      expect(find(plan, id).privileged).toBe(true);
      expect(find(plan, id).description).toMatch(/UNVERIFIED/);
    }
  });

  it("follows a custom homeBase", () => {
    const plan = planMigrate(config({ homeBase: "/srv/archive" }), "ann");
    expect(argvOf(plan, HOME_GUARD)).toContain("Environment=PASEO_HOME=/srv/archive/ann");
    expect(argvOf(plan, ENV_GUARD)).toContain("EnvironmentFile=/srv/archive/ann.env");
  });

  it("both run before the account exists", () => {
    const plan = planMigrate(config(), "ann");
    for (const g of [HOME_GUARD, ENV_GUARD]) {
      for (const later of ["ann.useradd", "ann.move-paseo-home", "ann.carry-secret-env"]) expect(idx(plan, g), `${g} < ${later}`).toBeLessThan(idx(plan, later));
      expect(idx(plan, g)).toBeGreaterThan(idx(plan, "ann.guard-old-daemon-stopped"));
    }
  });

  for (const g of ["ann.guard-old-unit-home", "ann.guard-old-unit-env"]) {
    it(`${g} failing stops the root phase before useradd, the move and the copy`, async () => {
      const plan = planMigrate(config(), "ann");
      const out = await tmp();
      await renderPlan(plan, out);
      const failing = JSON.stringify(argvOf(plan, g));
      const runner = new FakeRunner((a) => JSON.stringify(a) === failing);
      const r = await applyPlan(plan, out, runner, { isRoot: true });
      expect(r.ok).toBe(false);
      expect(r.failed?.id).toBe(g);
      const ran = new Set(runner.calls.map((a) => JSON.stringify(a)));
      for (const later of ["ann.useradd", "ann.move-paseo-home", "ann.chown-paseo-home", "ann.carry-secret-env"]) {
        expect(ran.has(JSON.stringify(argvOf(plan, later))), later).toBe(false);
      }
    });

    it(`${g} failing through the CLI says nothing changed and how to restart the shared unit`, async () => {
      const s = await stored();
      await s.run(["migrate", "ann"]);
      const plan = planMigrate(config(), "ann");
      const failing = JSON.stringify(argvOf(plan, g));
      const runner = new FakeRunner((a) => JSON.stringify(a) === failing);
      const r = await s.run(["migrate", "ann", "--apply", ...YES], { isRoot: () => true, runner });
      expect(r.code).toBe(1);
      expect(r.err).toContain(`FAILED at ${g}`);
      expect(r.err).toContain(`systemctl --user enable --now ${OLD_UNIT}`);
    });
  }
});

describe("finding 3 and 10: planMigrate validates a hand-built config as parseConfig does", () => {
  it("accepts the valid config (control)", () => {
    expect(planMigrate(config(), "ann").steps.length).toBeGreaterThan(5);
  });

  it("refuses an account home that is the operator's own home (root would chown it)", () => {
    const c = handBuilt({ userHome: "/home/ann", homeBase: "/home/ann/.paseo-people", unixAccountHomeBase: "/home" });
    c.people = c.people.map((p) => ({ ...p, unixAccount: "ann" }));
    expect(() => planMigrate(c, "ann")).toThrow(ConfigError);
    expect(() => planMigrate(c, "ann")).toThrow(/account home/);
  });

  it("refuses an account named like the operator, so that the account home is userHome", () => {
    const same = withPerson({ unixAccount: "tester" });
    expect(() => planMigrate(same, "ann")).toThrow(ConfigError);
    expect(() => planMigrate(same, "ann")).toThrow(/account home/);
  });

  it("refuses unixAccountHomeBase equal to userHome", () => {
    const c = handBuilt({ unixAccountHomeBase: "/home/tester" });
    expect(() => planMigrate(c, "ann")).toThrow(ConfigError);
  });

  it("refuses a person name with a path segment", () => {
    const c = config();
    const bad: ResolvedConfig = { ...c, people: c.people.map((p) => ({ ...p, name: "../x" })) };
    expect(() => planMigrate(bad, "../x")).toThrow(ConfigError);
  });

  it("refuses a relative homeBase and a relative unixAccountHomeBase", () => {
    expect(() => planMigrate(handBuilt({ homeBase: "rel" }), "ann")).toThrow(ConfigError);
    expect(() => planMigrate(handBuilt({ unixAccountHomeBase: "rel" }), "ann")).toThrow(ConfigError);
  });

  it("refuses an invalid port", () => {
    expect(() => planMigrate(withPerson({ port: 80 }), "ann")).toThrow(ConfigError);
    expect(() => planMigrate(withPerson({ port: 70000 }), "ann")).toThrow(ConfigError);
    expect(() => planMigrate(withPerson({ port: 1.5 }), "ann")).toThrow(ConfigError);
  });

  it("refuses an account home inside homeBase or at the host paseoBinary", () => {
    expect(() => planMigrate(handBuilt({ homeBase: "/home/tester/people", unixAccountHomeBase: "/home/tester/people" }), "ann")).toThrow(ConfigError);
    expect(() => planMigrate(handBuilt({ unixAccountHomeBase: "/opt/paseo/bin" , paseoBinary: "/opt/paseo/bin/acct-ann/paseo" }), "ann")).toThrow(ConfigError);
  });

  it("does not turn an unrelated same-user neighbour into an error (acknowledgements are not in a resolved config)", () => {
    const c = parseConfig({ ...raw(), people: [target(), { name: "bob", acknowledge: ["shared-provider-history"] }, { name: "cy", acknowledge: ["shared-provider-history"] }] });
    expect(() => planMigrate(c, "ann")).not.toThrow();
  });
});

describe("finding 7: a hand-built person name cannot add lines to apply.sh", () => {
  it("refuses a name with a newline before any script exists", () => {
    const c = config();
    const name = "ann\ntouch /tmp/pwned";
    const bad: ResolvedConfig = { ...c, people: c.people.map((p) => ({ ...p, name })) };
    expect(() => planMigrate(bad, name)).toThrow(ConfigError);
  });

  it("refuses a newline in a path of the hand-built config", () => {
    expect(() => planMigrate(handBuilt({ homeBase: "/srv/old\ntouch /tmp/pwned" }), "ann")).toThrow(ConfigError);
    expect(() => planMigrate(handBuilt({ userHome: "/home/tester\ntouch /tmp/pwned" }), "ann")).toThrow(ConfigError);
  });

  it("renderApplyScript keeps every description on its comment line", () => {
    const plan = planMigrate(config(), "ann");
    const hostile: Plan = { ...plan, steps: plan.steps.map((s, i) => (i === 0 ? { ...s, description: "harmless\ntouch /tmp/pwned" } : s)) };
    for (const line of renderApplyScript(hostile).split("\n")) {
      if (line.includes("touch /tmp/pwned")) expect(line.startsWith("#")).toBe(true);
    }
  });
});

describe("finding 4: a runner that cannot start a command is a failed step, not an escaped error", () => {
  class ThrowingRunner extends FakeRunner {
    constructor(private readonly when: (argv: string[]) => boolean) {
      super();
    }
    override async run(argv: string[], opts?: { cwd: string }) {
      if (this.when(argv)) {
        this.calls.push(argv);
        throw Object.assign(new Error(`spawn ${argv[0]} ENOENT`), { code: "ENOENT" });
      }
      return super.run(argv, opts);
    }
  }

  it("applyPlan returns the failed step and stops", async () => {
    const plan = planMigrate(config(), "ann");
    const out = await tmp();
    await renderPlan(plan, out);
    const failing = JSON.stringify(argvOf(plan, "ann.guard-old-home-dir"));
    const runner = new ThrowingRunner((a) => JSON.stringify(a) === failing);
    const r = await applyPlan(plan, out, runner, { isRoot: true });
    expect(r.ok).toBe(false);
    expect(r.failed?.id).toBe("ann.guard-old-home-dir");
    expect(r.failed?.error).toMatch(/ENOENT/);
    expect(runner.calls.some((a) => a[0] === "useradd")).toBe(false);
  });

  it("the CLI names the step and prints the restore command after the user phase stopped the daemon", async () => {
    const s = await stored();
    await s.run(["migrate", "ann"]);
    const userPhase = await s.run(["migrate", "ann", "--apply", ...YES], { isRoot: () => false });
    expect(userPhase.code, userPhase.err).toBe(0);
    const plan = planMigrate(config(), "ann");
    const failing = JSON.stringify(argvOf(plan, "ann.guard-old-parents"));
    const runner = new ThrowingRunner((a) => JSON.stringify(a) === failing);
    const r = await s.run(["migrate", "ann", "--apply", ...YES], { isRoot: () => true, runner });
    expect(r.code).toBe(1);
    expect(r.err).toContain("FAILED at ann.guard-old-parents");
    expect(r.err).toMatch(/ENOENT/);
    expect(r.err).toContain(`systemctl --user enable --now ${OLD_UNIT}`);
  });
});

describe("finding 5: render never writes through a symbolic link", () => {
  it("migrate --apply with a stale plan.json symlink leaves the link target alone", async () => {
    const s = await stored();
    const out = join(s.stateRoot, "migrate-ann");
    await mkdir(out, { recursive: true, mode: 0o700 });
    const sentinel = join(s.root, "sentinel.txt");
    await writeFile(sentinel, "SENTINEL");
    await chmod(sentinel, 0o640);
    await symlink(sentinel, join(out, "plan.json"));

    const r = await s.run(["migrate", "ann", "--apply", ...YES], { isRoot: () => true });
    expect(r.code, r.err).toBe(2);
    expect(s.runner.calls).toEqual([]);
    expect(await readFile(sentinel, "utf8")).toBe("SENTINEL");
    expect((await stat(sentinel)).mode & 0o777).toBe(0o640);
    // plan.json is now a regular file with the plan, so the next run can be compared with it.
    expect((await lstat(join(out, "plan.json"))).isSymbolicLink()).toBe(false);
    expect(JSON.parse(await readFile(join(out, "plan.json"), "utf8"))).toEqual(JSON.parse(JSON.stringify(planMigrate(config(), "ann"))));
  });

  it("renderPlan replaces symlinked plan.json, apply.sh and secrets files instead of following them", async () => {
    const plan = planMigrate(config(), "ann");
    const out = await tmp();
    const outside = await tmp();
    await renderPlan({ ...plan, steps: plan.steps.filter((x) => x.kind !== "file" || !x.file?.secretRef) }, out);
    const targets = ["plan.json", "apply.sh"];
    for (const t of targets) {
      await writeFile(join(outside, t), `KEEP ${t}`);
      await rmLink(join(out, t));
      await symlink(join(outside, t), join(out, t));
    }
    await renderPlan(plan, out);
    for (const t of targets) {
      expect(await readFile(join(outside, t), "utf8")).toBe(`KEEP ${t}`);
      expect((await lstat(join(out, t))).isSymbolicLink()).toBe(false);
    }
  });

  it("a password file that is a symbolic link is replaced, not written through", async () => {
    const plan = await sharedPlan();
    const out = await tmp();
    await renderPlan(plan, out);
    const outside = join(await tmp(), "victim");
    await writeFile(outside, "KEEP");
    const pw = join(out, "secrets", "ann.password");
    await rmLink(pw);
    await symlink(outside, pw);
    await renderPlan(plan, out);
    expect(await readFile(outside, "utf8")).toBe("KEEP");
    expect((await lstat(pw)).isSymbolicLink()).toBe(false);
    expect(((await stat(pw)).mode & 0o777)).toBe(0o600);
  });
});

async function rmLink(path: string): Promise<void> {
  const { rm } = await import("node:fs/promises");
  await rm(path, { force: true });
}

async function sharedPlan(): Promise<Plan> {
  const { planHost } = await import("../../tools/ctl/plan.js");
  return planHost(parseConfig({ ...BASE, people: [{ name: "ann", acknowledge: ["shared-provider-history"] }, { name: "bob", acknowledge: ["shared-provider-history"] }] }));
}

describe("finding 8 and 9: the failure report after the old unit was stopped", () => {
  async function run(failId: string, opts: { first?: string } = {}) {
    const s = await stored();
    await s.run(["migrate", "ann"]);
    const plan = planMigrate(config(), "ann");
    const fail = (id: string) => JSON.stringify(argvOf(plan, id));
    if (opts.first) {
      const first = new FakeRunner((a) => JSON.stringify(a) === fail(opts.first as string));
      await s.run(["migrate", "ann", "--apply", ...YES], { isRoot: () => true, runner: first });
    }
    const runner = new FakeRunner((a) => JSON.stringify(a) === fail(failId));
    return s.run(["migrate", "ann", "--apply", ...YES], { isRoot: () => true, runner });
  }

  it("finding 8: a rerun after a completed move does not tell you to re-enable the old unit", async () => {
    const r = await run("ann.guard-old-home-dir", { first: "ann.install-paseo" });
    expect(r.code).toBe(1);
    expect(r.err).toContain("FAILED at ann.guard-old-home-dir");
    expect(r.err).not.toContain("enable --now");
    expect(r.err).not.toMatch(/safe to run this command again/i);
    expect(r.err).not.toMatch(/Nothing on the host was changed/);
    expect(r.err).toMatch(/already migrated/);
    expect(r.err).toMatch(/must not be re-enabled|do not re-enable/i);
    expect(r.err).not.toContain("Not run: ann.useradd");
    expect(r.err).not.toContain("ann.useradd");
  });

  it("finding 8: the first run's report after the move is unchanged", async () => {
    const s = await stored();
    await s.run(["migrate", "ann"]);
    const plan = planMigrate(config(), "ann");
    const failing = JSON.stringify(argvOf(plan, "ann.install-paseo"));
    const r = await s.run(["migrate", "ann", "--apply", ...YES], { isRoot: () => true, runner: new FakeRunner((a) => JSON.stringify(a) === failing) });
    expect(r.err).toMatch(/already moved/);
    expect(r.err).not.toContain("enable --now");
  });

  for (const id of ["ann.useradd", "ann.lock-password", "ann.account-home", "ann.move-paseo-home"]) {
    it(`finding 9: a failure at ${id} before the move names the stopped unit and the enable command`, async () => {
      const r = await run(id);
      expect(r.code).toBe(1);
      expect(r.err).toContain(`FAILED at ${id}`);
      expect(r.err).toContain("ann.stop-shared");
      expect(r.err).toContain(`systemctl --user enable --now ${OLD_UNIT}`);
      expect(r.err).not.toMatch(/already moved/);
    });
  }

  it("finding 9: a failed move warns to check both paths before restarting", async () => {
    const r = await run("ann.move-paseo-home");
    expect(r.err).toMatch(/both|check .*PASEO_HOME/i);
  });

  it("finding 9: the plan refuses an account home that already exists, before useradd", () => {
    const plan = planMigrate(config(), "ann");
    expect(argvOf(plan, "ann.guard-old-account")).toEqual(["test", "!", "-e", "/home/acct-ann"]);
    expect(find(plan, "ann.guard-old-account").privileged).toBe(true);
    expect(find(plan, "ann.guard-old-account").description).toMatch(/UNVERIFIED/);
    expect(idx(plan, "ann.guard-old-account")).toBeLessThan(idx(plan, "ann.useradd"));
    expect(idx(plan, "ann.guard-old-account")).toBeGreaterThan(idx(plan, "ann.guard-old-daemon-stopped"));
  });

  it("finding 9: ann.guard-old-account failing gets the restore guidance of a preflight", async () => {
    const r = await run("ann.guard-old-account");
    expect(r.err).toContain(`systemctl --user enable --now ${OLD_UNIT}`);
    expect(r.err).toMatch(/nothing .*changed/i);
  });

  it("finding 9: a failure of the stop itself does not claim the old daemon is offline", async () => {
    const s = await stored();
    await s.run(["migrate", "ann"]);
    const plan = planMigrate(config(), "ann");
    const failing = JSON.stringify(argvOf(plan, "ann.stop-shared"));
    const r = await s.run(["migrate", "ann", "--apply", ...YES], { isRoot: () => false, runner: new FakeRunner((a) => JSON.stringify(a) === failing) });
    expect(r.code).toBe(1);
    expect(r.err).not.toContain("enable --now");
  });
});
