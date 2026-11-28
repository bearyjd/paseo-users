import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError, parseConfig } from "../../tools/ctl/config.js";
import { renderNotice } from "../../tools/ctl/notice.js";
import { planHost } from "../../tools/ctl/plan.js";
import { renderApplyScript } from "../../tools/ctl/render.js";
import { sandbox, writeJson, type Sandbox } from "./cli-helpers.js";
import { BASE, rawCfg, tmp } from "./helpers.js";

// Review round 3 fixes. Synthetic values only. Nothing runs on a host; every plan is only described and rendered into temp dirs.

const VERSION = "0.17.4";
const YES = ["--yes", "--i-understand-this-changes-the-host"];
const sepRaw = (name: string, acct: string, extra: Record<string, unknown> = {}) => ({
  name,
  isolation: "unix-account",
  unixAccount: acct,
  install: "separate",
  providers: ["claude"],
  ...extra,
});
const secretsDir = (s: Sandbox) => join(s.stateRoot, "render", "secrets");
const read = (path: string) => readFile(path, "utf8");
const exists = (path: string) => access(path).then(() => true, () => false);

async function inited(): Promise<Sandbox> {
  const s = await sandbox();
  expect((await s.run(["init", "--listen", "127.0.0.1"])).code).toBe(0);
  return s;
}

describe("a different --config never deletes the default config's staged secrets", () => {
  async function renderedAnn() {
    const s = await inited();
    expect((await s.run(["add", "ann", "--shared"])).code).toBe(0);
    expect((await s.run(["render"])).code).toBe(0);
    const other = join(s.root, "other.json");
    expect((await s.run(["init", "--listen", "127.0.0.1", "--config", other])).code).toBe(0);
    const before = { password: await read(join(secretsDir(s), "ann.password")), env: await read(join(secretsDir(s), "ann.env")) };
    return { s, other, before };
  }
  const unchanged = async (s: Sandbox, before: { password: string; env: string }) => {
    expect(await read(join(secretsDir(s), "ann.password"))).toBe(before.password);
    expect(await read(join(secretsDir(s), "ann.env"))).toBe(before.env);
  };

  it("add --shared and remove with --config", async () => {
    const { s, other, before } = await renderedAnn();
    expect((await s.run(["add", "ann", "--shared", "--config", other])).code).toBe(0);
    await unchanged(s, before);
    const removed = await s.run(["remove", "ann", "--config", other]);
    expect(removed.code).toBe(0);
    expect(removed.out).not.toMatch(/staged password files .* were deleted/);
    await unchanged(s, before);
  });

  it("add --separate with --config", async () => {
    const { s, other, before } = await renderedAnn();
    const r = await s.run(["add", "ann", "--separate", "--unix-account", "acct-ann", "--providers", "claude", "--paseo-version", VERSION, "--config", other]);
    expect(r.code).toBe(0);
    await unchanged(s, before);
  });

  it("the default config still forgets a removed name", async () => {
    const { s } = await renderedAnn();
    expect((await s.run(["remove", "ann"])).code).toBe(0);
    expect(await exists(join(secretsDir(s), "ann.password"))).toBe(false);
    expect(await exists(join(secretsDir(s), "ann.env"))).toBe(false);
  });
});

describe("init --force does not hand a replacement person the previous person's password", () => {
  async function bobOnOld() {
    const s = await inited();
    expect((await s.run(["add", "bob", "--separate", "--unix-account", "acct-old", "--providers", "claude", "--paseo-version", VERSION])).code).toBe(0);
    expect((await s.run(["render"])).code).toBe(0);
    return { s, oldPassword: await read(join(secretsDir(s), "bob.password")) };
  }
  const adopt = async (s: Sandbox, people: unknown[]) => {
    const file = await writeJson(join(s.root, "replacement.json"), { ...BASE, paseoVersion: VERSION, people });
    return s.run(["init", "--force", "--from", file]);
  };

  it("a name on a different unix account gets a new password", async () => {
    const { s, oldPassword } = await bobOnOld();
    expect((await adopt(s, [sepRaw("bob", "acct-new")])).code).toBe(0);
    const r = await s.run(["render"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("new passwords: bob");
    expect(await read(join(secretsDir(s), "bob.password"))).not.toBe(oldPassword);
  });

  it("a name that is gone from the replacement is forgotten", async () => {
    const { s } = await bobOnOld();
    expect((await adopt(s, [sepRaw("cy", "acct-cy")])).code).toBe(0);
    expect(await exists(join(secretsDir(s), "bob.password"))).toBe(false);
    expect(await exists(join(secretsDir(s), "bob.env"))).toBe(false);
  });

  it("the same person on the same account keeps their password", async () => {
    const { s, oldPassword } = await bobOnOld();
    expect((await adopt(s, [sepRaw("bob", "acct-old")])).code).toBe(0);
    expect((await s.run(["render"])).out).toContain("kept passwords: bob");
    expect(await read(join(secretsDir(s), "bob.password"))).toBe(oldPassword);
  });

  it("init --force on an alternate --config does not touch the default render directory", async () => {
    const { s, oldPassword } = await bobOnOld();
    const other = join(s.root, "other.json");
    expect((await s.run(["init", "--listen", "127.0.0.1", "--config", other])).code).toBe(0);
    expect((await s.run(["init", "--force", "--listen", "127.0.0.1", "--config", other])).code).toBe(0);
    expect(await read(join(secretsDir(s), "bob.password"))).toBe(oldPassword);
  });
});

describe("a trailing name on the legacy apply form is refused, not ignored", () => {
  it("apply <config.json> <name> runs nothing", async () => {
    const s = await sandbox();
    const file = await writeJson(join(s.root, "c.json"), { ...BASE, paseoVersion: VERSION, people: [sepRaw("bob", "acct-bob"), sepRaw("cy", "acct-cy")] });
    const out = join(s.root, "rendered");
    expect((await s.run(["render", file, "--out", out])).code).toBe(0);
    const r = await s.run(["apply", file, "bob", "--out", out, ...YES], { isRoot: () => true });
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/bob/);
    expect(s.runner.calls).toEqual([]);
  });

  it("apply <name> <extra> runs nothing", async () => {
    const s = await inited();
    expect((await s.run(["add", "bob", "--separate", "--unix-account", "acct-bob", "--providers", "claude", "--paseo-version", VERSION])).code).toBe(0);
    expect((await s.run(["render"])).code).toBe(0);
    const r = await s.run(["apply", "bob", "cy", ...YES], { isRoot: () => true });
    expect(r.code).toBe(2);
    expect(s.runner.calls).toEqual([]);
  });
});

describe("apply.sh runs account commands from /", () => {
  const plan = () => planHost(parseConfig(rawCfg({ paseoVersion: VERSION, people: [sepRaw("bob", "acct-bob")] })));

  it("every runuser line leaves the render directory, and staged copies still use it", () => {
    const lines = renderApplyScript(plan()).split("\n");
    const account = lines.filter((l) => !l.startsWith("#") && l.includes("runuser"));
    expect(account.length).toBeGreaterThan(0);
    for (const l of account) expect(l, l).toMatch(/\(cd \/ && runuser /);
    const staged = lines.filter((l) => !l.startsWith("#") && /\binstall -m\b/.test(l) && !l.includes("runuser"));
    expect(staged.length).toBeGreaterThan(0);
    for (const l of staged) expect(l, l).not.toContain("cd /");
    expect(lines).toContain('cd "$(dirname "$0")"');
  });
});

describe("a legacy host-binary unix-account person keeps working under the operator's home", () => {
  const layout = { userHome: "/srv/operator", unixAccountHomeBase: "/srv/operator/accounts" };

  it("no install field: still parsed, host-binary plan", () => {
    const config = parseConfig(rawCfg({ ...layout, people: [{ name: "ann", isolation: "unix-account", unixAccount: "ann" }] }));
    const text = JSON.stringify(planHost(config));
    expect(text).toContain(BASE.paseoBinary);
  });

  it("the same layout with install separate is refused", () => {
    expect(() => parseConfig(rawCfg({ ...layout, paseoVersion: VERSION, people: [sepRaw("ann", "ann")] }))).toThrow(/userHome/);
  });
});

describe("a '.' segment in environmentPath", () => {
  const environmentPath = "%h/.local/./bin:/usr/bin";

  it("is still accepted for a same-user-only config, and reaches the unit", () => {
    const config = parseConfig(rawCfg({ environmentPath, people: [{ name: "ann" }] }));
    expect(JSON.stringify(planHost(config))).toContain(environmentPath);
  });

  it("is refused when anyone is separate", () => {
    expect(() => parseConfig(rawCfg({ environmentPath, paseoVersion: VERSION, people: [sepRaw("bob", "acct-bob")] }))).toThrow(ConfigError);
    expect(() => parseConfig(rawCfg({ environmentPath: "%h/bin/..", paseoVersion: VERSION, people: [sepRaw("bob", "acct-bob")] }))).toThrow(ConfigError);
  });
});

describe("the separate notice promises nothing about the operator's files", () => {
  it("makes no unconditional readability claim", () => {
    const text = renderNotice({ name: "bob", isolation: "unix-account", install: "separate", providers: ["claude"] });
    expect(text).not.toMatch(/readable/i);
    expect(text).toMatch(/checked/i);
  });
});

describe("password does not suggest a re-apply that stops at useradd", () => {
  it("separate and legacy unix-account people", async () => {
    const s = await inited();
    expect((await s.run(["add", "bob", "--separate", "--unix-account", "acct-bob", "--providers", "claude", "--paseo-version", VERSION])).code).toBe(0);
    expect((await s.run(["add", "cy", "--shared", "--acknowledge-shared-history"])).code).toBe(0);
    const bob = await s.run(["password", "bob"]);
    expect(bob.code).toBe(0);
    expect(bob.out).not.toContain("paseo-users apply");
    expect(bob.out).toContain("install -m");
    const cy = await s.run(["password", "cy"]);
    expect(cy.out).toContain("paseo-users apply cy");
  });
});

describe("ports of people already in the config do not move", () => {
  async function twoAuto() {
    const s = await inited();
    expect((await s.run(["add", "ann", "--shared"])).code).toBe(0);
    expect((await s.run(["add", "bob", "--shared", "--acknowledge-shared-history"])).code).toBe(0);
    return s;
  }
  const ports = async (s: Sandbox) => Object.fromEntries((JSON.parse((await s.run(["list", "--json"])).out) as { name: string; port: number }[]).map((r) => [r.name, r.port]));

  it("add --port onto an auto-assigned port is refused and changes nothing", async () => {
    const s = await twoAuto();
    expect(await ports(s)).toEqual({ ann: 7100, bob: 7101 });
    const before = await read(s.configFile);
    const r = await s.run(["add", "cat", "--shared", "--acknowledge-shared-history", "--port", "7100"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("ann");
    expect(await read(s.configFile)).toBe(before);
  });

  it("an explicit free port is still accepted", async () => {
    const s = await twoAuto();
    expect((await s.run(["add", "cat", "--shared", "--acknowledge-shared-history", "--port", "7150"])).code).toBe(0);
    expect(await ports(s)).toEqual({ ann: 7100, bob: 7101, cat: 7150 });
  });

  it("remove keeps the remaining people on their ports", async () => {
    const s = await twoAuto();
    expect((await s.run(["remove", "ann"])).code).toBe(0);
    expect(await ports(s)).toEqual({ bob: 7101 });
  });
});
