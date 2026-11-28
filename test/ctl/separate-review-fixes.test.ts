import { access, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyPlan, ApplyRefused } from "../../tools/ctl/apply.js";
import { ConfigError, parseConfig } from "../../tools/ctl/config.js";
import { planForPerson, planHost } from "../../tools/ctl/plan.js";
import { renderPlan } from "../../tools/ctl/render.js";
import { sandbox, writeJson, type Sandbox } from "./cli-helpers.js";
import { FakeRunner, rawCfg, tmp } from "./helpers.js";

// Fixes for the review of the separate-install work. Synthetic values only. Nothing runs on a host.

const VERSION = "0.17.4";
const ACK = ["shared-provider-history"];
const sepRaw = (name: string, acct: string, extra: Record<string, unknown> = {}) => ({
  name,
  isolation: "unix-account",
  unixAccount: acct,
  install: "separate",
  providers: ["claude"],
  ...extra,
});
const SEP_FLAGS = ["--separate", "--unix-account", "acct-bob", "--paseo-version", VERSION];
const exists = (path: string) => access(path).then(() => true, () => false);

describe("apply checks every selected staged secret before the first command", () => {
  const separateConfig = () => parseConfig(rawCfg({ paseoVersion: VERSION, people: [sepRaw("bob", "acct-bob")] }));

  it("refuses before handing anything to the runner when the staged .env is gone", async () => {
    const plan = planHost(separateConfig());
    const out = await tmp();
    await renderPlan(plan, out);
    await rm(join(out, "secrets", "bob.env"));
    const runner = new FakeRunner();
    await expect(applyPlan(plan, out, runner, { isRoot: true })).rejects.toThrow(ApplyRefused);
    expect(runner.calls).toEqual([]);
  });

  it("only checks the secrets of the selected steps", async () => {
    const config = parseConfig(rawCfg({ paseoVersion: VERSION, people: [sepRaw("bob", "acct-bob"), sepRaw("cy", "acct-cy")] }));
    const plan = planHost(config);
    const out = await tmp();
    await renderPlan(plan, out);
    await rm(join(out, "secrets", "cy.env"));
    const runner = new FakeRunner();
    const r = await applyPlan(plan, out, runner, { isRoot: true, only: (id) => id.startsWith("bob.") });
    expect(r.ok).toBe(true);
    expect(runner.calls.length).toBeGreaterThan(0);
  });
});

describe("repeating a single-value flag is refused, not last-wins", () => {
  const cases: [string, string[]][] = [
    ["--providers", ["--providers", "unknown", "--providers", "claude"]],
    ["--paseo-version", ["--paseo-version", "latest", "--paseo-version", VERSION]],
    ["--unix-account", ["--unix-account", "bad name", "--unix-account", "acct-bob"]],
    ["--port", ["--port", "70", "--port", "7150"]],
  ];
  for (const [flag, repeated] of cases) {
    it(`${flag}: exit 2 and the config is byte-for-byte unchanged`, async () => {
      const s = await sandbox();
      expect((await s.run(["init", "--listen", "127.0.0.1"])).code).toBe(0);
      const before = await readFile(s.configFile, "utf8");
      const base = ["add", "bob", "--separate", "--unix-account", "acct-bob", "--providers", "claude", "--paseo-version", VERSION];
      const drop = base.indexOf(flag);
      const args = flag === "--port" ? [...base, ...repeated] : [...base.slice(0, drop), ...base.slice(drop + 2), ...repeated];
      const r = await s.run(args);
      expect(r.code).toBe(2);
      expect(r.err).toContain(flag);
      expect(await readFile(s.configFile, "utf8")).toBe(before);
    });
  }

  it("a repeated --existing is still allowed for init", async () => {
    const s = await sandbox();
    const r = await s.run(["init", "--listen", "127.0.0.1", "--existing", "old-a:6767", "--existing", "old-b:6768"]);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(JSON.parse(await readFile(s.configFile, "utf8")).existingDaemons).toHaveLength(2);
  });
});

describe("a re-used person name never inherits the previous password", () => {
  const passwordOf = (s: Sandbox) => readFile(join(s.stateRoot, "render", "secrets", "bob.password"), "utf8");

  async function sharedBobRendered(): Promise<{ s: Sandbox; old: string }> {
    const s = await sandbox();
    expect((await s.run(["init", "--listen", "127.0.0.1"])).code).toBe(0);
    expect((await s.run(["add", "bob", "--shared"])).code).toBe(0);
    expect((await s.run(["render"])).code).toBe(0);
    return { s, old: await passwordOf(s) };
  }

  it("remove, add as separate, render: the replacement gets a fresh password in .password and .env", async () => {
    const { s, old } = await sharedBobRendered();
    expect((await s.run(["remove", "bob"])).code).toBe(0);
    expect((await s.run(["add", "bob", ...SEP_FLAGS, "--providers", "claude"])).code).toBe(0);
    expect((await s.run(["render"])).code).toBe(0);
    const fresh = await passwordOf(s);
    expect(fresh.trim().length).toBeGreaterThan(0);
    expect(fresh).not.toBe(old);
    const env = await readFile(join(s.stateRoot, "render", "secrets", "bob.env"), "utf8");
    expect(env).toBe(`PASEO_PASSWORD=${fresh.trim()}\n`);
    expect(env).not.toContain(old.trim());
  });

  it("remove deletes the removed person's staged secrets", async () => {
    const { s } = await sharedBobRendered();
    expect((await s.run(["remove", "bob"])).code).toBe(0);
    expect(await exists(join(s.stateRoot, "render", "secrets", "bob.password"))).toBe(false);
    expect(await exists(join(s.stateRoot, "render", "secrets", "bob.env"))).toBe(false);
  });

  it("add also drops leftovers when the config was edited by hand instead of using remove", async () => {
    const { s, old } = await sharedBobRendered();
    await writeJson(s.configFile, { ...rawCfg(), people: [] });
    expect((await s.run(["add", "bob", ...SEP_FLAGS, "--providers", "claude"])).code).toBe(0);
    expect((await s.run(["render"])).code).toBe(0);
    expect(await passwordOf(s)).not.toBe(old);
  });

  it("remove leaves other people's secrets alone", async () => {
    const s = await sandbox();
    await s.run(["init", "--listen", "127.0.0.1"]);
    await s.run(["add", "ann", "--shared"]);
    await s.run(["add", "bob", "--shared", "--acknowledge-shared-history"]);
    await s.run(["render"]);
    expect((await s.run(["remove", "bob"])).code).toBe(0);
    expect(await exists(join(s.stateRoot, "render", "secrets", "ann.password"))).toBe(true);
    expect(await exists(join(s.stateRoot, "render", "secrets", "ann.env"))).toBe(true);
  });
});

describe("a legacy unix-account neighbour puts no operator path into a separate person's plan", () => {
  const withNeighbour = (extra: Record<string, unknown>) =>
    parseConfig(
      rawCfg({
        unixAccountHomeBase: "/opt/paseo",
        paseoBinary: "/opt/paseo/legacy/bin/paseo",
        paseoVersion: VERSION,
        people: [{ name: "legacy", isolation: "unix-account", unixAccount: "legacy" }, sepRaw("bob", "acct-bob")],
        ...extra,
      }),
    );
  const bobPlan = (c: ReturnType<typeof withNeighbour>) => JSON.stringify(planForPerson(planHost(c), "bob"));

  it("omits the neighbour's HOME when the host paseoBinary sits under it", () => {
    expect(bobPlan(withNeighbour({}))).not.toContain("/opt/paseo/legacy");
  });

  it("omits the neighbour's HOME when it equals an environmentPath entry", () => {
    expect(bobPlan(withNeighbour({ environmentPath: "/opt/paseo/legacy" }))).not.toContain("/opt/paseo/legacy");
  });

  it("still checks a neighbour that is not an operator path", () => {
    const text = bobPlan(withNeighbour({ paseoBinary: "/opt/tools/bin/paseo" }));
    expect(text).toContain("HOME=/opt/paseo/legacy");
  });
});

describe("account commands do not inherit the operator's working directory", () => {
  it("runs runuser steps from / and file installs from the output directory", async () => {
    const config = parseConfig(rawCfg({ paseoVersion: VERSION, people: [sepRaw("bob", "acct-bob")] }));
    const plan = planHost(config);
    const out = await tmp();
    await renderPlan(plan, out);
    const runner = new FakeRunner();
    const r = await applyPlan(plan, out, runner, { isRoot: true });
    expect(r.ok).toBe(true);
    const account = runner.calls.map((argv, i) => ({ argv, cwd: runner.cwds[i] })).filter((c) => c.argv[0] === "runuser");
    expect(account.length).toBeGreaterThan(0);
    for (const c of account) expect(c.cwd).toBe("/");
    const installs = runner.calls.map((argv, i) => ({ argv, cwd: runner.cwds[i] })).filter((c) => c.argv[0] === "install" && c.argv.some((a) => a.startsWith("files/") || a.startsWith("secrets/")));
    expect(installs.length).toBeGreaterThan(0);
    for (const c of installs) expect(c.cwd).toBe(out);
  });
});

describe("a lone shared person can get a separate neighbour", () => {
  it("add --separate works next to a shared person without an acknowledgement", async () => {
    const s = await sandbox();
    await s.run(["init", "--listen", "127.0.0.1"]);
    expect((await s.run(["add", "ann", "--shared"])).code).toBe(0);
    const r = await s.run(["add", "bob", ...SEP_FLAGS, "--providers", "claude"]);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    const stored = JSON.parse(await readFile(s.configFile, "utf8"));
    expect(stored.people.map((p: { name: string }) => p.name)).toEqual(["ann", "bob"]);
  });

  it("still requires it for a second same-user person, a legacy account neighbour and an existing daemon", () => {
    expect(() => parseConfig(rawCfg({ people: [{ name: "ann" }, { name: "bob" }] }))).toThrow(ConfigError);
    expect(() => parseConfig(rawCfg({ people: [{ name: "ann" }, { name: "cy", isolation: "unix-account", unixAccount: "svc-cy" }] }))).toThrow(ConfigError);
    expect(() => parseConfig(rawCfg({ existingDaemons: [{ port: 6767 }], people: [{ name: "ann" }] }))).toThrow(ConfigError);
    expect(() => parseConfig(rawCfg({ paseoVersion: VERSION, people: [{ name: "ann", acknowledge: ACK }, { name: "bob" }] }))).toThrow(ConfigError);
  });

  it("a separate person does not count, but a shared neighbour next to it still does", () => {
    const sepOnly = rawCfg({ paseoVersion: VERSION, people: [{ name: "ann" }, sepRaw("bob", "acct-bob")] });
    expect(() => parseConfig(sepOnly)).not.toThrow();
    const two = rawCfg({ paseoVersion: VERSION, people: [{ name: "ann" }, { name: "cy" }, sepRaw("bob", "acct-bob")] });
    expect(() => parseConfig(two)).toThrow(ConfigError);
  });
});
