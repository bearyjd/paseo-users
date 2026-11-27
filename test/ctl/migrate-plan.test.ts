import { readdir } from "node:fs/promises";
import { beforeAll, describe, expect, it } from "vitest";
import { applyPlan } from "../../tools/ctl/apply.js";
import { parseConfig, type ResolvedConfig } from "../../tools/ctl/config.js";
import { createRegistry, type Step } from "../../tools/ctl/isolation/index.js";
import { planHost, planMigrate, type Plan } from "../../tools/ctl/plan.js";
import { renderPlan } from "../../tools/ctl/render.js";
import { stepArgv } from "../../tools/ctl/shell.js";
import { FakeRunner, rawCfg, tmp } from "./helpers.js";

// Slice 4, RED phase: planMigrate (docs/12-separate-installs-plan.md section 5). The config describes the TARGET (ann is
// unix-account + install separate, on the same port). The SOURCE is ann's shared layout (same-user strategy). Plans are
// data and apply runs through FakeRunner: nothing here touches a host, and none of it is verified on one.
//
// Step ids this file expects (new steps first, then the slice 2 ids that are reused as they are):
//   ann.stop-shared            unprivileged: stop and disable the shared unit (the operator's user manager)
//   ann.guard-old-daemon-stopped  privileged, the FIRST privileged step: fails while the old daemon may still run
//   ann.move-paseo-home        privileged: mv the old PASEO_HOME into the account
//   ann.chown-paseo-home       privileged: chown -R it to the account
//   ann.carry-secret-env       privileged: install the existing password env file into the account, 0600
//   ann.migrate-note           manual: provider logins start fresh, provider history stays behind

const VERSION = "0.17.4";
const ACK = ["shared-provider-history"];
const NEW_HOME = "/home/acct-ann/.paseo-daemon";
const NEW_ENV = "/home/acct-ann/.paseo-daemon.env";
const OLD_HOME = "/home/tester/.paseo-people/ann";
const OLD_ENV = "/home/tester/.paseo-people/ann.env";
const OLD_UNIT = "paseo-ann.service";
const AS_ACCT = ["runuser", "-u", "acct-ann", "--", "env", "-i", "HOME=/home/acct-ann", "PATH=/usr/local/bin:/usr/bin:/bin"];

/** Operator values that must never reach the target side. BASE.userHome is /home/tester. */
const PASEO_BINARY = "/opt/paseo/bin/paseo";
const ENV_PATH_VALUES = ["/opt/operator-tools/bin", "operator-secret-dir"];

/** Steps that may name the old (shared) layout: they are the ones that stop, move and copy it. */
const PREFLIGHT_IDS = [
  "ann.guard-old-unit-disabled",
  "ann.guard-old-home-link",
  "ann.guard-old-home-dir",
  "ann.guard-old-env-link",
  "ann.guard-old-env-file",
  "ann.guard-old-hardlinks",
];
const OLD_SIDE = ["ann.stop-shared", "ann.guard-old-daemon-stopped", ...PREFLIGHT_IDS, "ann.move-paseo-home", "ann.carry-secret-env", "ann.migrate-note"];

const target = (extra: Record<string, unknown> = {}) => ({
  name: "ann",
  isolation: "unix-account",
  unixAccount: "acct-ann",
  install: "separate",
  providers: ["claude", "codex"],
  port: 7150,
  ...extra,
});
const config = (people: Record<string, unknown>[] = [target()], extra: Record<string, unknown> = {}): ResolvedConfig =>
  parseConfig(rawCfg({ paseoVersion: VERSION, environmentPath: "%h/operator-secret-dir:/opt/operator-tools/bin", people, ...extra }));

const find = (p: Plan, id: string): Step => {
  const s = p.steps.find((x) => x.id === id);
  if (!s) throw new Error(`step ${id} is missing from the migration plan (ids: ${p.steps.map((x) => x.id).join(", ")})`);
  return s;
};
const argvOf = (p: Plan, id: string): string[] => {
  const a = stepArgv(find(p, id));
  if (!a) throw new Error(`step ${id} has no command`);
  return a;
};
const idx = (p: Plan, id: string): number => {
  const i = p.steps.findIndex((s) => s.id === id);
  if (i < 0) throw new Error(`step ${id} is missing from the migration plan`);
  return i;
};
const GUARD = "ann.guard-old-daemon-stopped";
const unitOf = (p: Plan) => find(p, "ann.unit").file?.content ?? "";
/** Whether a step's command names the old PASEO_HOME or old env file as an argument. */
const touchesOld = (s: Step): boolean => (stepArgv(s) ?? []).some((a) => a === OLD_HOME || a === OLD_ENV);

describe("planMigrate refuses (fails closed) unless the person is separate", () => {
  it("refuses a same-user person: there is nothing to migrate to", () => {
    const ctx = config([{ name: "ann" }], { paseoVersion: undefined });
    expect(() => planMigrate(ctx, "ann")).toThrow(/separate/);
  });

  it("refuses a same-user person who is explicitly install shared", () => {
    const ctx = config([{ name: "ann", install: "shared" }, target({ name: "bob", unixAccount: "acct-bob", port: 7160 })]);
    expect(() => planMigrate(ctx, "ann")).toThrow(/separate/);
  });

  it("refuses a unix-account person with no install field (today's host-binary mode)", () => {
    const ctx = config([{ name: "ann", isolation: "unix-account", unixAccount: "acct-ann" }, target({ name: "bob", unixAccount: "acct-bob", port: 7160 })]);
    expect(() => planMigrate(ctx, "ann")).toThrow(/separate/);
  });

  it("refuses an unknown person and names the known ones", () => {
    expect(() => planMigrate(config(), "zed")).toThrow(/unknown person "zed".*ann/);
  });

  it("refuses an empty name", () => {
    expect(() => planMigrate(config(), "")).toThrow(/unknown person/);
  });

  it("refuses when the isolation strategy is not in the registry (no silent fallback)", () => {
    expect(() => planMigrate(config(), "ann", createRegistry([]))).toThrow(/unknown isolation strategy/);
  });

  it("does not change the config it is given and is deterministic", () => {
    const ctx = config();
    const before = JSON.stringify(ctx);
    const a = planMigrate(ctx, "ann");
    const b = planMigrate(ctx, "ann");
    expect(JSON.stringify(ctx)).toBe(before);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe("planMigrate: what the plan describes", () => {
  let plan: Plan;
  beforeAll(() => {
    plan = planMigrate(config(), "ann");
  });

  it("describes ann as the separate person on the SAME port, with the PASEO_HOME inside the account", () => {
    expect(plan.people).toEqual([
      {
        name: "ann",
        isolation: "unix-account",
        port: 7150,
        paseoHome: NEW_HOME,
        unixAccount: "acct-ann",
        install: "separate",
        providers: ["claude", "codex"],
      },
    ]);
  });

  it("never rotates: rotate is empty", () => {
    expect(plan.rotate).toEqual([]);
  });

  it("keeps the warnings that apply to a separate person (unpinned providers, own logins)", () => {
    const text = plan.warnings.join("\n");
    expect(text).toMatch(/unpinned/);
    expect(text).toMatch(/own logins/);
  });

  it("covers only ann: no other person's step, no same-user prerequisite, in steps or verify", () => {
    const ctx = config([
      target(),
      { name: "bob", acknowledge: ACK },
      { name: "cy", isolation: "unix-account", unixAccount: "svc-cy" },
      target({ name: "dee", unixAccount: "acct-dee", providers: ["opencode"], port: 7170 }),
    ]);
    const p = planMigrate(ctx, "ann");
    expect(p.people.map((x: { name: string }) => x.name)).toEqual(["ann"]);
    for (const s of [...p.steps, ...p.verify] as Step[]) expect(s.id.startsWith("ann."), s.id).toBe(true);
    expect(p.steps.some((s: Step) => s.id.startsWith("same-user."))).toBe(false);
  });

  it("neighbours do not change ann's steps", () => {
    const alone = planMigrate(config(), "ann");
    const crowded = planMigrate(config([target(), { name: "bob", acknowledge: ACK }, target({ name: "dee", unixAccount: "acct-dee", port: 7170 })]), "ann");
    expect(JSON.stringify(crowded.steps)).toBe(JSON.stringify(alone.steps));
  });

  it("honours unixAccountHomeBase and a homeBase of the old layout", () => {
    const p = planMigrate(config([target()], { unixAccountHomeBase: "/srv/people", homeBase: "/srv/old-people" }), "ann");
    const mv = argvOf(p, "ann.move-paseo-home");
    expect(mv.at(-2)).toBe("/srv/old-people/ann");
    expect(mv.at(-1)).toBe("/srv/people/acct-ann/.paseo-daemon");
    expect(argvOf(p, "ann.carry-secret-env").slice(-2)).toEqual(["/srv/old-people/ann.env", "/srv/people/acct-ann/.paseo-daemon.env"]);
    expect(unitOf(p)).toContain("PASEO_HOME=/srv/people/acct-ann/.paseo-daemon");
  });
});

describe("planMigrate: account and installs reuse the slice 2 steps, without a fresh PASEO_HOME or a rendered password", () => {
  let plan: Plan;
  let fresh: Plan;
  beforeAll(() => {
    const ctx = config();
    plan = planMigrate(ctx, "ann");
    fresh = planHost(ctx);
  });
  const REUSED = [
    "ann.useradd",
    "ann.lock-password",
    "ann.account-home",
    "ann.config-dir",
    "ann.systemd-dir",
    "ann.unit-dir",
    "ann.guard-config",
    "ann.guard-systemd",
    "ann.guard-unit-dir",
    "ann.guard-secret-env",
    "ann.guard-unit",
    "ann.unit",
    "ann.local-dir",
    "ann.npm-prefix",
    "ann.install-paseo",
    "ann.install-claude",
    "ann.install-codex",
    "ann.linger",
    "ann.daemon-reload",
    "ann.enable",
    "ann.login-claude",
    "ann.login-codex",
  ];

  it.each(REUSED)("%s is the same step a fresh separate install would run", (id) => {
    expect(find(plan, id)).toEqual(find(fresh, id));
  });

  it("keeps the manual provider login step", () => {
    expect(find(plan, "ann.llm-login").kind).toBe("manual");
  });

  it("installs only the listed providers", () => {
    expect(plan.steps.some((s) => s.id === "ann.install-opencode")).toBe(false);
  });

  it("does NOT create a fresh PASEO_HOME (an mv into an existing directory would nest the old home inside it)", () => {
    expect(plan.steps.some((s) => s.id === "ann.paseo-home")).toBe(false);
    for (const s of plan.steps) {
      const argv = stepArgv(s) ?? [];
      const makesNewHome =
        (argv.includes("mkdir") && argv.at(-1) === NEW_HOME) || (argv[0] === "install" && argv.includes("-d") && argv.includes(NEW_HOME));
      expect(makesNewHome, s.id).toBe(false);
    }
  });

  it("renders no new password: no step carries a secretRef, none writes the env file from a staged secret", () => {
    for (const s of plan.steps) {
      expect(s.file?.secretRef, s.id).toBeUndefined();
      expect(s.file?.path, s.id).not.toBe(NEW_ENV);
    }
    expect(plan.steps.some((s) => s.id === "ann.secret-env")).toBe(false);
    expect(JSON.stringify(plan)).not.toContain("PASEO_PASSWORD");
  });

  it("rendering the plan generates no password and stages no secrets directory", async () => {
    const out = await tmp();
    const r = await renderPlan(plan, out, {
      randomBytes: () => {
        throw new Error("a migration must never generate a password");
      },
    });
    expect(r.generated).toEqual([]);
    expect(r.kept).toEqual([]);
    expect(await readdir(out)).not.toContain("secrets");
  });
});

describe("planMigrate: the new unit", () => {
  let plan: Plan;
  let unit = "";
  beforeAll(() => {
    plan = planMigrate(config(), "ann");
    unit = unitOf(plan);
  });

  it("is the account's own daemon on the same port, in the moved PASEO_HOME, reading the carried env file", () => {
    expect(unit).toContain("Environment=PASEO_LISTEN=127.0.0.1:7150\n");
    expect(unit).toContain(`Environment=PASEO_HOME=${NEW_HOME}\n`);
    expect(unit).toContain(`EnvironmentFile=${NEW_ENV}\n`);
    expect(unit).toContain(`ExecStart=/home/acct-ann/.local/npm/bin/paseo daemon run --home ${NEW_HOME}\n`);
    expect(unit).toContain("Environment=PATH=/home/acct-ann/.local/npm/bin:/usr/local/bin:/usr/bin:/bin\n");
  });

  it("holds no password", () => {
    expect(unit).not.toMatch(/PASSWORD/i);
  });
});

describe("planMigrate: stopping the shared unit", () => {
  let plan: Plan;
  beforeAll(() => {
    plan = planMigrate(config(), "ann");
  });

  it("stops and disables the shared unit through the operator's own user manager, unprivileged", () => {
    const s = find(plan, "ann.stop-shared");
    expect(s.kind).toBe("command");
    expect(s.privileged).not.toBe(true);
    expect(stepArgv(s)).toEqual(["systemctl", "--user", "disable", "--now", OLD_UNIT]);
  });

  it("is the first step of the plan", () => {
    expect(idx(plan, "ann.stop-shared")).toBe(0);
  });

  it("is the only unprivileged step that touches the old layout", () => {
    for (const s of plan.steps) {
      if (s.id === "ann.stop-shared" || s.privileged === true) continue;
      expect(touchesOld(s), s.id).toBe(false);
    }
  });
});

describe("planMigrate: the guard makes moving PASEO_HOME impossible while the old daemon may run", () => {
  let plan: Plan;
  beforeAll(() => {
    plan = planMigrate(config(), "ann");
  });

  it("is a privileged, shell-free command step that names the old unit or the old PASEO_HOME", () => {
    const g = find(plan, GUARD);
    expect(g.kind).toBe("command");
    expect(g.privileged).toBe(true);
    const argv = stepArgv(g) ?? [];
    expect(argv.length).toBeGreaterThan(0);
    expect(["sh", "bash", "dash", "-c"].some((x) => argv.includes(x))).toBe(false);
    expect(argv.some((a) => a.includes(OLD_UNIT) || a.includes(OLD_HOME))).toBe(true);
    expect(g.description).toMatch(/UNVERIFIED/);
  });

  it("is the FIRST privileged step: nothing runs as root before it, so the root phase cannot start without it", () => {
    const privileged = plan.steps.filter((s) => s.privileged === true);
    expect(privileged[0]?.id).toBe(GUARD);
    const g = idx(plan, GUARD);
    for (const s of plan.steps) {
      if (s.privileged === true && s.id !== GUARD) expect(idx(plan, s.id), s.id).toBeGreaterThan(g);
    }
  });

  it("runs before the account is created and before anything moves", () => {
    for (const id of ["ann.useradd", "ann.move-paseo-home", "ann.chown-paseo-home", "ann.carry-secret-env", "ann.enable"]) {
      expect(idx(plan, GUARD), id).toBeLessThan(idx(plan, id));
    }
  });

  it("every step that reads or moves the old layout, other than the stop and the guard, is privileged and after the guard", () => {
    const g = idx(plan, GUARD);
    const readers = plan.steps.filter((s) => !["ann.stop-shared", GUARD].includes(s.id) && touchesOld(s));
    expect(readers.map((s) => s.id).sort()).toEqual(
      ["ann.carry-secret-env", "ann.move-paseo-home", "ann.guard-old-home-link", "ann.guard-old-home-dir", "ann.guard-old-env-link", "ann.guard-old-env-file", "ann.guard-old-hardlinks"].sort(),
    );
    for (const s of readers) {
      expect(s.privileged, s.id).toBe(true);
      expect(idx(plan, s.id), s.id).toBeGreaterThan(g);
    }
  });

  it("root phase alone: while the guard fails, nothing else runs (no account, no move, no copy)", async () => {
    const out = await tmp();
    await renderPlan(plan, out);
    const guardArgv = JSON.stringify(argvOf(plan, GUARD));
    const runner = new FakeRunner((argv) => JSON.stringify(argv) === guardArgv);
    const r = await applyPlan(plan, out, runner, { isRoot: true });
    expect(r.ok).toBe(false);
    expect(r.failed?.id).toBe(GUARD);
    expect(runner.calls).toEqual([argvOf(plan, GUARD)]);
    expect(r.executed).toEqual([]);
  });

  it("the unprivileged phase runs only the stop, and never a move, copy or chown", async () => {
    const out = await tmp();
    await renderPlan(plan, out);
    const runner = new FakeRunner();
    const r = await applyPlan(plan, out, runner, { isRoot: false });
    expect(r.ok).toBe(true);
    expect(runner.calls).toEqual([["systemctl", "--user", "disable", "--now", OLD_UNIT]]);
  });

  it("user phase then root phase: the guard runs first in the root phase, then the move, chown and the rest, in plan order", async () => {
    const out = await tmp();
    await renderPlan(plan, out);
    const runner = new FakeRunner();
    expect((await applyPlan(plan, out, runner, { isRoot: false })).ok).toBe(true);
    const asRoot = new FakeRunner();
    const r = await applyPlan(plan, out, asRoot, { isRoot: true });
    expect(r.ok).toBe(true);
    expect(asRoot.calls[0]).toEqual(argvOf(plan, GUARD));
    const order = asRoot.calls.map((a) => JSON.stringify(a));
    const at = (id: string) => order.indexOf(JSON.stringify(argvOf(plan, id)));
    expect(at(GUARD)).toBe(0);
    expect(at("ann.useradd")).toBeGreaterThan(at(GUARD));
    expect(at("ann.move-paseo-home")).toBeGreaterThan(at("ann.account-home"));
    expect(at("ann.chown-paseo-home")).toBeGreaterThan(at("ann.move-paseo-home"));
    expect(at("ann.enable")).toBeGreaterThan(at("ann.chown-paseo-home"));
    expect(r.executed.filter((id) => plan.steps.find((s) => s.id === id)?.privileged !== true)).toEqual([]);
  });

  it("a failing move stops everything after it: no chown, no env copy, no daemon start", async () => {
    const out = await tmp();
    await renderPlan(plan, out);
    const mv = JSON.stringify(argvOf(plan, "ann.move-paseo-home"));
    const runner = new FakeRunner((argv) => JSON.stringify(argv) === mv);
    const r = await applyPlan(plan, out, runner, { isRoot: true });
    expect(r.ok).toBe(false);
    expect(r.failed?.id).toBe("ann.move-paseo-home");
    const ran = new Set(runner.calls.map((a) => JSON.stringify(a)));
    for (const id of ["ann.chown-paseo-home", "ann.carry-secret-env", "ann.daemon-reload", "ann.enable", "ann.install-paseo"]) {
      expect(ran.has(JSON.stringify(argvOf(plan, id))), id).toBe(false);
    }
  });
});

describe("planMigrate: moving PASEO_HOME", () => {
  let plan: Plan;
  beforeAll(() => {
    plan = planMigrate(config(), "ann");
  });
  let mv: string[] = [];
  let chown: string[] = [];
  beforeAll(() => {
    mv = argvOf(plan, "ann.move-paseo-home");
    chown = argvOf(plan, "ann.chown-paseo-home");
  });

  it("is a privileged mv of the old home onto the new path, and never nests into an existing directory", () => {
    expect(find(plan, "ann.move-paseo-home").privileged).toBe(true);
    expect(mv[0]).toBe("mv");
    expect(mv.at(-2)).toBe(OLD_HOME);
    expect(mv.at(-1)).toBe(NEW_HOME);
    // -T: the destination is the new PASEO_HOME itself. If something is already there, mv fails instead of nesting.
    expect(mv.includes("-T") || mv.includes("--no-target-directory")).toBe(true);
    expect(find(plan, "ann.move-paseo-home").description).toMatch(/UNVERIFIED/);
  });

  it("is ordered after the account home exists (the destination's parent)", () => {
    expect(idx(plan, "ann.account-home")).toBeLessThan(idx(plan, "ann.move-paseo-home"));
  });

  it("is followed by a privileged recursive chown to the account that does not follow symlinks", () => {
    expect(find(plan, "ann.chown-paseo-home").privileged).toBe(true);
    expect(chown[0]).toBe("chown");
    expect(chown.some((a) => a === "-R" || a === "--recursive")).toBe(true);
    expect(chown.includes("-L") || chown.includes("-H")).toBe(false);
    expect(chown.some((a) => /^acct-ann(:acct-ann)?$/.test(a))).toBe(true);
    expect(chown.at(-1)).toBe(NEW_HOME);
    expect(idx(plan, "ann.chown-paseo-home")).toBeGreaterThan(idx(plan, "ann.move-paseo-home"));
    expect(find(plan, "ann.chown-paseo-home").description).toMatch(/UNVERIFIED/);
  });

  it("the move and the chown come before any account code runs, and before the daemon starts", () => {
    for (const id of ["ann.move-paseo-home", "ann.chown-paseo-home"]) {
      for (const later of ["ann.local-dir", "ann.npm-prefix", "ann.install-paseo", "ann.install-claude", "ann.daemon-reload", "ann.enable"]) {
        expect(idx(plan, id), `${id} before ${later}`).toBeLessThan(idx(plan, later));
      }
    }
  });
});

describe("planMigrate: carrying the existing password across", () => {
  let plan: Plan;
  beforeAll(() => {
    plan = planMigrate(config(), "ann");
  });
  let carry: string[] = [];
  beforeAll(() => {
    carry = argvOf(plan, "ann.carry-secret-env");
  });

  it("installs the old env file at the new path, mode 0600, owner and group the account, set at creation", () => {
    expect(find(plan, "ann.carry-secret-env").privileged).toBe(true);
    expect(carry[0]).toBe("install");
    expect(carry.includes("-d")).toBe(false);
    const flag = (f: string) => carry[carry.indexOf(f) + 1];
    expect(flag("-m")).toBe("0600");
    expect(flag("-o")).toBe("acct-ann");
    expect(flag("-g")).toBe("acct-ann");
    expect(carry.slice(-2)).toEqual([OLD_ENV, NEW_ENV]);
    expect(find(plan, "ann.carry-secret-env").description).toMatch(/UNVERIFIED/);
  });

  it("is a command, not a file step: the plan holds no password and render stages none", () => {
    const s = find(plan, "ann.carry-secret-env");
    expect(s.kind).toBe("command");
    expect(s.file).toBeUndefined();
  });

  it("comes after the symlink guard for the destination and before the daemon starts, and before any account code", () => {
    expect(idx(plan, "ann.guard-secret-env")).toBeLessThan(idx(plan, "ann.carry-secret-env"));
    expect(idx(plan, "ann.account-home")).toBeLessThan(idx(plan, "ann.carry-secret-env"));
    for (const later of ["ann.local-dir", "ann.install-paseo", "ann.daemon-reload", "ann.enable"]) {
      expect(idx(plan, "ann.carry-secret-env"), later).toBeLessThan(idx(plan, later));
    }
  });

  it("no root install runs after account code (npm) has run, as for a fresh separate install", async () => {
    const out = await tmp();
    await renderPlan(plan, out);
    const runner = new FakeRunner();
    const r = await applyPlan(plan, out, runner, { isRoot: true });
    expect(r.ok).toBe(true);
    const firstNpm = runner.calls.findIndex((a) => a.includes("npm"));
    expect(firstNpm).toBeGreaterThan(0);
    expect(runner.calls.slice(firstNpm).filter((a) => a[0] === "install" || a[0] === "mv" || a[0] === "chown")).toEqual([]);
  });
});

describe("planMigrate: the manual note", () => {
  let plan: Plan;
  beforeAll(() => {
    plan = planMigrate(config(), "ann");
  });

  it("says provider logins start fresh and the operator's provider history stays behind, and marks it unverified", () => {
    const n = find(plan, "ann.migrate-note");
    expect(n.kind).toBe("manual");
    expect(stepArgv(n)).toBeUndefined();
    expect(n.description).toMatch(/^MANUAL/);
    expect(n.description).toMatch(/fresh/i);
    expect(n.description).toMatch(/history/i);
    expect(n.description).toMatch(/behind/i);
    expect(n.description).toMatch(/UNVERIFIED/);
  });

  it("never offers to copy provider credentials or history", () => {
    const text = JSON.stringify(plan);
    expect(text).not.toMatch(/\/\.claude|\/\.codex|\/\.opencode|\/\.config\/(claude|codex|opencode)|auth\.json/i);
  });
});

describe("planMigrate: no operator value leaks into the target side", () => {
  const variants: [string, ResolvedConfig][] = [
    ["default homeBase (under userHome)", config()],
    ["a homeBase outside userHome", config([target()], { homeBase: "/srv/old-people" })],
    [
      "a neighbour on each side",
      config([target(), { name: "bob", acknowledge: ACK }, { name: "cy", isolation: "unix-account", unixAccount: "svc-cy" }, target({ name: "dee", unixAccount: "acct-dee", port: 7170 })]),
    ],
  ];

  describe.each(variants)("%s", (_label, ctx) => {
    let plan: Plan;
    beforeAll(() => {
      plan = planMigrate(ctx, "ann");
    });
    const oldValues = [`${ctx.homeBase}/ann`, `${ctx.homeBase}/ann.env`];

    it("the host paseoBinary and the environmentPath entries appear nowhere at all", () => {
      const text = JSON.stringify(plan);
      for (const bad of [PASEO_BINARY, ...ENV_PATH_VALUES]) expect(text, bad).not.toContain(bad);
    });

    it("the old layout (userHome, homeBase, old PASEO_HOME, old env file) appears only in the stop, guards, move, copy and note steps", () => {
      const bad = [ctx.userHome, ctx.homeBase, ...oldValues];
      for (const s of plan.steps) {
        if (OLD_SIDE.includes(s.id)) continue;
        for (const b of bad) expect(JSON.stringify(s), `${s.id} must not contain ${b}`).not.toContain(b);
      }
      for (const b of bad) {
        expect(JSON.stringify(plan.verify), `verify must not contain ${b}`).not.toContain(b);
        expect(JSON.stringify(plan.warnings), `warnings must not contain ${b}`).not.toContain(b);
        expect(JSON.stringify(plan.people), `people must not contain ${b}`).not.toContain(b);
      }
    });

    it("the new unit names nothing from the old layout", () => {
      const unit = unitOf(plan);
      for (const b of [ctx.userHome, ctx.homeBase, PASEO_BINARY, ...ENV_PATH_VALUES]) expect(unit, b).not.toContain(b);
    });

    it("every account-level command (runuser) is free of the old layout and of operator values", () => {
      const asAccount = [...plan.steps, ...plan.verify].filter((s) => stepArgv(s)?.[0] === "runuser");
      expect(asAccount.length).toBeGreaterThan(5);
      for (const s of asAccount) {
        const text = JSON.stringify(stepArgv(s));
        for (const b of [ctx.userHome, ctx.homeBase, PASEO_BINARY, ...ENV_PATH_VALUES]) expect(text, `${s.id} must not contain ${b}`).not.toContain(b);
      }
      for (const s of plan.steps.filter((x) => stepArgv(x)?.[0] === "runuser")) {
        expect(stepArgv(s)?.slice(0, AS_ACCT.length), s.id).toEqual(AS_ACCT);
      }
    });

    it("the guard, move and copy name only the old paths they act on, not the host paseoBinary or environmentPath", () => {
      for (const id of OLD_SIDE) {
        const text = JSON.stringify(find(plan, id));
        for (const b of [PASEO_BINARY, ...ENV_PATH_VALUES]) expect(text, `${id} must not contain ${b}`).not.toContain(b);
      }
    });
  });
});

describe("planMigrate: step commands are argv arrays, never a shell string", () => {
  let plan: Plan;
  beforeAll(() => {
    plan = planMigrate(config(), "ann");
  });

  it("no step runs sh or bash, and every command step has a non-empty argv", () => {
    for (const s of [...plan.steps, ...plan.verify]) {
      if (s.kind !== "command") continue;
      expect(Array.isArray(s.command), s.id).toBe(true);
      expect((s.command ?? []).length, s.id).toBeGreaterThan(0);
      for (const a of s.command ?? []) expect(typeof a, s.id).toBe("string");
      const argv = stepArgv(s) ?? [];
      expect(["sh", "bash", "dash", "-c"].some((x) => argv.includes(x)), s.id).toBe(false);
    }
  });
});
