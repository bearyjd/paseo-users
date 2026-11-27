import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseConfig } from "../../tools/ctl/config.js";
import type { Step } from "../../tools/ctl/isolation/index.js";
import { planMigrate, type Plan } from "../../tools/ctl/plan.js";
import { stepArgv } from "../../tools/ctl/shell.js";
import { sandbox, writeJson, type Sandbox } from "./cli-helpers.js";
import { BASE, FakeRunner } from "./helpers.js";

// Slice 4, RED phase: `paseo-users migrate <name>` (docs/12-separate-installs-plan.md section 5, docs/13-cli.md).
// Everything runs against fakes and temp directories. Nothing is executed on a host, and nothing here is verified on one.
// Default behaviour mirrors `revoke`: render the plan into its own directory and apply nothing, unless --apply and both
// confirmation flags are given. Step ids are the ones in migrate-plan.test.ts.

const YES = ["--yes", "--i-understand-this-changes-the-host"];
const VERSION = "0.17.4";
const ACK = ["shared-provider-history"];
const OLD_HOME = "/home/tester/.paseo-people/ann";
const OLD_UNIT = "paseo-ann.service";
const GUARD = "ann.guard-old-daemon-stopped";
const OPERATOR_VALUES = ["/opt/paseo/bin/paseo", "/opt/operator-tools/bin", "operator-secret-dir"];

const sepAnn = { name: "ann", isolation: "unix-account", unixAccount: "acct-ann", install: "separate", providers: ["claude", "codex"], port: 7150 };
const raw = (people: Record<string, unknown>[] = [sepAnn]) => ({
  ...BASE,
  paseoVersion: VERSION,
  environmentPath: "%h/operator-secret-dir:/opt/operator-tools/bin",
  people,
});

async function stored(people?: Record<string, unknown>[]): Promise<Sandbox> {
  const s = await sandbox();
  await writeJson(s.configFile, raw(people));
  return s;
}

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else out.push(p);
  }
  return out;
}

const expected = (): Plan => planMigrate(parseConfig(raw()), "ann");
const guardArgv = () => {
  const g = expected().steps.find((x: Step) => x.id === GUARD);
  return g ? stepArgv(g) : undefined;
};

/** A refusal: exit 2, a message naming the problem, the config unchanged, nothing run, nothing rendered. */
async function expectRefused(s: Sandbox, args: string[], ...needles: (string | RegExp)[]) {
  const before = await readFile(s.configFile, "utf8");
  const r = await s.run(["migrate", ...args]);
  expect(r.code, `exit code, stderr: ${r.err}`).toBe(2);
  for (const n of needles) {
    if (typeof n === "string") expect(r.err).toContain(n);
    else expect(r.err).toMatch(n);
  }
  // The refusal must come from the feature, not from an unknown command.
  expect(r.err).not.toContain("paseo-users (formerly paseo-ctl)");
  expect(await readFile(s.configFile, "utf8")).toBe(before);
  expect(s.runner.calls).toEqual([]);
  return r;
}

describe("migrate is a command", () => {
  it("is listed in the usage text", async () => {
    const s = await sandbox();
    const r = await s.run(["help"]);
    expect(r.out).toContain("migrate <name>");
  });
});

describe("migrate <name>: render and review, apply nothing", () => {
  it("renders the migration plan into its own directory, prints it, and runs nothing", async () => {
    const s = await stored();
    const before = await readFile(s.configFile, "utf8");
    const r = await s.run(["migrate", "ann"]);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(s.runner.calls).toEqual([]);
    expect(await readFile(s.configFile, "utf8")).toBe(before);
    const out = join(s.stateRoot, "migrate-ann");
    expect(JSON.parse(await readFile(join(out, "plan.json"), "utf8"))).toEqual(JSON.parse(JSON.stringify(expected())));
    expect(await readFile(join(out, "apply.sh"), "utf8")).toContain("ann.move-paseo-home");
    expect(((await stat(out)).mode & 0o777)).toBe(0o700);
    expect(r.out).toMatch(/Nothing was applied|host was not changed/i);
    expect(r.out).toContain("ann.stop-shared");
    expect(r.out).toContain(GUARD);
    expect(r.out).toContain("port 7150");
    // It does not use or disturb the normal render directory.
    await expect(stat(join(s.stateRoot, "render"))).rejects.toThrow();
  });

  it("generates no password and stages no secret: the existing password is carried by a copy step, not rendered", async () => {
    const s = await stored();
    const r = await s.run(["migrate", "ann"]);
    expect(r.code, r.err).toBe(0);
    const out = join(s.stateRoot, "migrate-ann");
    const files = await walk(out);
    expect(files.filter((f) => f.includes("/secrets/"))).toEqual([]);
    expect(await readdir(out)).not.toContain("secrets");
    for (const f of files) expect(await readFile(f, "utf8"), f).not.toContain("PASEO_PASSWORD");
    expect(r.out).not.toMatch(/new passwords: ann|Generated a new random password/);
  });

  it("the rendered unit and files hold no host paseoBinary or environmentPath", async () => {
    const s = await stored();
    await s.run(["migrate", "ann"]);
    const out = join(s.stateRoot, "migrate-ann");
    const plan = await readFile(join(out, "plan.json"), "utf8");
    for (const bad of OPERATOR_VALUES) expect(plan, bad).not.toContain(bad);
    const unit = await readFile(join(out, "files/home/acct-ann/.config/systemd/user", OLD_UNIT), "utf8");
    expect(unit).toContain("Environment=PASEO_LISTEN=127.0.0.1:7150\n");
    expect(unit).toContain("Environment=PASEO_HOME=/home/acct-ann/.paseo-daemon\n");
    expect(unit).not.toContain("/home/tester");
  });

  it("apply.sh runs the guard first in the root phase, before the move", async () => {
    const s = await stored();
    await s.run(["migrate", "ann"]);
    const script = await readFile(join(s.stateRoot, "migrate-ann", "apply.sh"), "utf8");
    const lines = script.split("\n");
    const rootLines = lines.map((l, i) => [l, i] as const).filter(([l]) => l.startsWith('if [ "$phase" = root ]'));
    expect(rootLines.length).toBeGreaterThan(3);
    const firstRoot = rootLines[0] as readonly [string, number];
    expect(lines[firstRoot[1] - 1]).toContain(`# ${GUARD}:`);
    const mv = lines.findIndex((l) => l.startsWith("if [") && l.includes("mv") && l.includes(OLD_HOME));
    expect(mv).toBeGreaterThan(firstRoot[1]);
    // The stop is the one command of the user phase.
    const userLines = lines.filter((l) => l.startsWith('if [ "$phase" = user ]'));
    expect(userLines).toHaveLength(1);
    expect(userLines[0]).toContain("disable --now " + OLD_UNIT);
  });

  it("--out renders there instead", async () => {
    const s = await stored();
    const out = join(s.root, "mig-out");
    const r = await s.run(["migrate", "ann", "--out", out]);
    expect(r.code, r.err).toBe(0);
    expect(JSON.parse(await readFile(join(out, "plan.json"), "utf8")).people[0].name).toBe("ann");
    await expect(stat(join(s.stateRoot, "migrate-ann"))).rejects.toThrow();
  });

  it("--config uses another stored config", async () => {
    const s = await sandbox();
    const other = join(s.root, "other.json");
    await writeJson(other, raw());
    const r = await s.run(["migrate", "ann", "--config", other]);
    expect(r.code, r.err).toBe(0);
    expect(s.runner.calls).toEqual([]);
  });

  it("does not touch a neighbour: only ann's steps are in the plan", async () => {
    const s = await stored([sepAnn, { name: "bob", acknowledge: ACK }, { name: "cy", isolation: "unix-account", unixAccount: "svc-cy" }]);
    const r = await s.run(["migrate", "ann"]);
    expect(r.code, r.err).toBe(0);
    const plan = JSON.parse(await readFile(join(s.stateRoot, "migrate-ann", "plan.json"), "utf8"));
    expect(plan.people.map((p: { name: string }) => p.name)).toEqual(["ann"]);
    for (const step of plan.steps) expect(step.id.startsWith("ann."), step.id).toBe(true);
  });
});

describe("migrate <name>: refusals", () => {
  it("refuses a person who is not separate and says why", async () => {
    const s = await stored([{ name: "ann" }, { ...sepAnn, name: "bob", unixAccount: "acct-bob", port: 7160 }]);
    await expectRefused(s, ["ann"], /separate/);
    await expect(stat(join(s.stateRoot, "migrate-ann"))).rejects.toThrow();
  });

  it("refuses a unix-account person with no install field", async () => {
    const s = await stored([{ name: "ann", isolation: "unix-account", unixAccount: "acct-ann" }, { ...sepAnn, name: "bob", unixAccount: "acct-bob", port: 7160 }]);
    await expectRefused(s, ["ann"], /separate/);
  });

  it("refuses an unknown person", async () => {
    const s = await stored();
    await expectRefused(s, ["zed"], /unknown person "zed"/);
  });

  it("needs a person name", async () => {
    const s = await stored();
    await expectRefused(s, [], /name/i);
  });

  it("takes exactly one name", async () => {
    const s = await stored();
    await expectRefused(s, ["ann", "bob"], /usage|one|name/i);
  });

  it("refuses an unknown flag and a repeated --out", async () => {
    const s = await stored();
    await expectRefused(s, ["ann", "--bogus"], "unknown flag --bogus");
    await expectRefused(s, ["ann", "--out", "/tmp/a", "--out", "/tmp/b"], "more than once");
  });

  it("refuses an invalid stored config (nothing is guessed)", async () => {
    const s = await sandbox();
    await writeJson(s.configFile, raw([{ ...sepAnn, providers: [] }]));
    await expectRefused(s, ["ann"], /provider/i);
  });

  it("with no stored config, says to run init", async () => {
    const s = await sandbox();
    const r = await s.run(["migrate", "ann"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("no config");
    expect(r.err).toContain("init");
    expect(r.err).not.toContain("paseo-users (formerly paseo-ctl)");
    expect(s.runner.calls).toEqual([]);
  });
});

describe("migrate <name> --apply", () => {
  it("needs both confirmation flags, otherwise runs nothing", async () => {
    for (const flags of [[], ["--yes"], ["--i-understand-this-changes-the-host"]]) {
      const s = await stored();
      const r = await s.run(["migrate", "ann", "--apply", ...flags]);
      expect(r.code, flags.join(" ")).toBe(2);
      expect(r.err).toContain("refusing");
      expect(s.runner.calls).toEqual([]);
    }
  });

  it("as a normal user runs only the stop, and says what is left for root", async () => {
    const s = await stored();
    await s.run(["migrate", "ann"]); // review first: migrate --apply applies only the rendered plan
    const r = await s.run(["migrate", "ann", "--apply", ...YES], { isRoot: () => false });
    expect(r.code, r.err).toBe(0);
    expect(r.err).toContain("privileged");
    expect(s.runner.calls).toEqual([["systemctl", "--user", "disable", "--now", OLD_UNIT]]);
    expect(r.out).toContain("ok     ann.stop-shared");
    expect(r.out).toContain(`skip   ${GUARD} (needs-root)`);
  });

  it("as root runs the guard first, then the rest in plan order, and no unprivileged step", async () => {
    const s = await stored();
    await s.run(["migrate", "ann"]); // review first: migrate --apply applies only the rendered plan
    const r = await s.run(["migrate", "ann", "--apply", ...YES], { isRoot: () => true });
    expect(r.code, r.err).toBe(0);
    const plan: Plan = expected();
    const rootIds = plan.steps.filter((x: Step) => x.privileged && stepArgv(x)).map((x: Step) => x.id);
    expect(rootIds[0]).toBe(GUARD);
    expect(s.runner.calls[0]).toEqual(guardArgv());
    expect(s.runner.calls).toHaveLength(rootIds.length);
    const ran = s.runner.calls.map((a) => JSON.stringify(a));
    const pos = (id: string) => ran.indexOf(JSON.stringify(stepArgv(plan.steps.find((x: Step) => x.id === id) as Step)));
    expect(pos("ann.move-paseo-home")).toBeGreaterThan(pos(GUARD));
    expect(pos("ann.chown-paseo-home")).toBeGreaterThan(pos("ann.move-paseo-home"));
    expect(pos("ann.enable")).toBeGreaterThan(pos("ann.chown-paseo-home"));
    expect(s.runner.calls.some((a) => a.includes("--user") && a[0] === "systemctl" && a.includes("disable"))).toBe(false);
  });

  it("as root with a guard that fails (old daemon still running): exit 1, nothing else runs, nothing moves", async () => {
    const s = await stored();
    const g = JSON.stringify(guardArgv());
    const runner = new FakeRunner((argv) => JSON.stringify(argv) === g);
    await s.run(["migrate", "ann"]); // review first: migrate --apply applies only the rendered plan
    const r = await s.run(["migrate", "ann", "--apply", ...YES], { isRoot: () => true, runner });
    expect(r.code).toBe(1);
    expect(r.err).toContain(`FAILED at ${GUARD}`);
    expect(runner.calls).toEqual([guardArgv()]);
    expect(r.out).not.toContain("ok     ann.useradd");
  });

  it("the rendered migration plan is applied exactly as reviewed: no new password is rendered while applying", async () => {
    const s = await stored();
    await s.run(["migrate", "ann"]); // review first: migrate --apply applies only the rendered plan
    const r = await s.run(["migrate", "ann", "--apply", ...YES], { isRoot: () => true });
    expect(r.code, r.err).toBe(0);
    expect(await readdir(join(s.stateRoot, "migrate-ann"))).not.toContain("secrets");
    expect(r.out).not.toMatch(/new passwords: ann/);
  });

  it("never passes a shell to the runner", async () => {
    const s = await stored();
    await s.run(["migrate", "ann"]); // review first: migrate --apply applies only the rendered plan
    const r = await s.run(["migrate", "ann", "--apply", ...YES], { isRoot: () => true });
    expect(r.code, r.err).toBe(0);
    expect(s.runner.calls.length).toBeGreaterThan(5);
    for (const argv of s.runner.calls) expect(["sh", "bash", "dash", "-c"].some((x) => argv.includes(x)), argv.join(" ")).toBe(false);
  });
});
