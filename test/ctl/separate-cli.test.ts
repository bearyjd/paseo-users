import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseConfig } from "../../tools/ctl/config.js";
import { writeNotices } from "../../tools/ctl/notice.js";
import { planHost, type Plan, type PlanPerson } from "../../tools/ctl/plan.js";
import { getProvider } from "../../tools/ctl/providers.js";
import { FakeQuery, sandbox, writeJson, type Sandbox } from "./cli-helpers.js";
import { BASE, rawCfg } from "./helpers.js";

// Slice 3: the CLI surface of separate installs (docs/12-separate-installs-plan.md sections 3-5, docs/13-cli.md).
// Everything runs against fakes and temp directories. Nothing is executed on a host, and nothing here is verified on one.

const YES = ["--yes", "--i-understand-this-changes-the-host"];
const ACK = ["shared-provider-history"];
const VERSION = "0.17.4";
const OPERATOR_VALUES = ["/home/tester", "/opt/paseo/bin/paseo", "/opt/operator-tools/bin", "operator-secret-dir"];

/** Flags that make a valid separate person named by the caller. */
const SEP_FLAGS = ["--separate", "--unix-account", "acct-bob", "--providers", "claude,codex", "--paseo-version", VERSION];

const sepRaw = (name: string, acct: string, providers: string[], extra: Record<string, unknown> = {}) => ({
  name,
  isolation: "unix-account",
  unixAccount: acct,
  install: "separate",
  providers,
  ...extra,
});

/** Operator-side values that must never reach a separate person's output. */
const withOperatorValues = (people: Record<string, unknown>[]) => ({
  ...BASE,
  paseoVersion: VERSION,
  environmentPath: "%h/operator-secret-dir:/opt/operator-tools/bin",
  people,
});

/** ann: shared, bob: separate (claude, codex), cy: unix-account on the host binary, dee: separate (opencode). */
const mixedConfig = () =>
  withOperatorValues([
    { name: "ann", acknowledge: ACK },
    sepRaw("bob", "acct-bob", ["claude", "codex"]),
    { name: "cy", isolation: "unix-account", unixAccount: "svc-cy" },
    sepRaw("dee", "acct-dee", ["opencode"]),
  ]);

const separateOnlyConfig = () => withOperatorValues([sepRaw("bob", "acct-bob", ["claude", "codex"])]);

async function inited(): Promise<Sandbox> {
  const s = await sandbox();
  expect((await s.run(["init", "--listen", "127.0.0.1"])).code).toBe(0);
  return s;
}

const readStored = async (s: Sandbox) => JSON.parse(await readFile(s.configFile, "utf8"));

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else out.push(p);
  }
  return out;
}

/** A refusal: exit 2, a message that names the problem, the config byte-for-byte as before, nothing run. */
async function expectRefused(s: Sandbox, args: string[], ...needles: (string | RegExp)[]) {
  const before = await readFile(s.configFile, "utf8");
  const r = await s.run(["add", ...args]);
  expect(r.code, `exit code, stderr: ${r.err}`).toBe(2);
  for (const n of needles) {
    if (typeof n === "string") expect(r.err).toContain(n);
    else expect(r.err).toMatch(n);
  }
  // The refusal must come from the feature, not from a missing flag or the old placeholder.
  expect(r.err).not.toContain("unknown flag");
  expect(r.err).not.toContain("not implemented");
  expect(await readFile(s.configFile, "utf8")).toBe(before);
  expect(s.runner.calls).toEqual([]);
  return r;
}

describe("add <name> --separate: creates a separate person", () => {
  it("stores install, providers, the unix account and a top-level paseoVersion, and does not touch the host", async () => {
    const s = await inited();
    const r = await s.run(["add", "bob", ...SEP_FLAGS]);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    const stored = await readStored(s);
    expect(stored.paseoVersion).toBe(VERSION);
    expect(stored.people).toEqual([
      { name: "bob", isolation: "unix-account", unixAccount: "acct-bob", install: "separate", providers: ["claude", "codex"] },
    ]);
    expect(r.out).toContain("host was not changed");
    expect(r.out).toContain("separate");
    expect(r.out).toContain("port 7100");
    expect(r.out).toContain("paseo-users plan bob");
    expect(s.runner.calls).toEqual([]);
    expect(((await stat(s.configFile)).mode & 0o777)).toBe(0o600);
    // The stored config parses, and the person resolves as a separate install.
    const resolved = parseConfig(stored);
    expect(resolved.paseoVersion).toBe(VERSION);
    expect(resolved.people[0]).toMatchObject({ name: "bob", install: "separate", providers: ["claude", "codex"], unixAccount: "acct-bob" });
  });

  it("tells the person the operator must still log in to each provider by hand (the plan cannot do it)", async () => {
    const s = await inited();
    const r = await s.run(["add", "bob", ...SEP_FLAGS]);
    expect(r.out).toMatch(/log ?in/i);
  });

  it("keeps the providers in the order given, and --port is honoured", async () => {
    const s = await inited();
    const r = await s.run(["add", "bob", "--separate", "--unix-account", "acct-bob", "--providers", "opencode,claude", "--paseo-version", VERSION, "--port", "7150"]);
    expect(r.err).toBe("");
    expect(r.out).toContain("port 7150");
    const p = (await readStored(s)).people[0];
    expect(p.providers).toEqual(["opencode", "claude"]);
    expect(p.port).toBe(7150);
  });

  it("accepts an exact prerelease version", async () => {
    const s = await inited();
    const r = await s.run(["add", "bob", "--separate", "--unix-account", "acct-bob", "--providers", "claude", "--paseo-version", "0.18.0-beta.1"]);
    expect(r.err).toBe("");
    expect((await readStored(s)).paseoVersion).toBe("0.18.0-beta.1");
  });

  it("a second separate person reuses the stored paseoVersion when --paseo-version is omitted", async () => {
    const s = await inited();
    await s.run(["add", "bob", ...SEP_FLAGS]);
    const r = await s.run(["add", "cy", "--separate", "--unix-account", "acct-cy", "--providers", "codex"]);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    const stored = await readStored(s);
    expect(stored.paseoVersion).toBe(VERSION);
    expect(stored.people.map((p: { name: string }) => p.name)).toEqual(["bob", "cy"]);
    expect(stored.people[1].providers).toEqual(["codex"]);
  });

  it("accepts the same --paseo-version as the stored one", async () => {
    const s = await inited();
    await s.run(["add", "bob", ...SEP_FLAGS]);
    const r = await s.run(["add", "cy", "--separate", "--unix-account", "acct-cy", "--providers", "codex", "--paseo-version", VERSION]);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
  });

  it("can sit next to an acknowledged shared person without writing an acknowledgement for the separate person", async () => {
    const s = await inited();
    expect((await s.run(["add", "ann", "--shared", "--acknowledge-shared-history"])).code).toBe(0);
    const r = await s.run(["add", "bob", ...SEP_FLAGS]);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    const stored = await readStored(s);
    expect(stored.people[0]).toEqual({ name: "ann", acknowledge: ACK });
    expect(stored.people[1]).not.toHaveProperty("acknowledge");
  });

  it("the shared path is unchanged: add --shared writes no install, providers or paseoVersion", async () => {
    const s = await inited();
    await s.run(["add", "ann", "--shared"]);
    const stored = await readStored(s);
    expect(stored.people).toEqual([{ name: "ann" }]);
    expect(stored).not.toHaveProperty("paseoVersion");
  });
});

describe("add <name> --separate: refuses an invalid result, with a clear message and no config write", () => {
  it("needs --unix-account (there is no silent default account name)", async () => {
    const s = await inited();
    await expectRefused(s, ["bob", "--separate", "--providers", "claude", "--paseo-version", VERSION], "--unix-account");
  });

  it("needs --providers", async () => {
    const s = await inited();
    await expectRefused(s, ["bob", "--separate", "--unix-account", "acct-bob", "--paseo-version", VERSION], "--providers");
  });

  it.each([
    ["an empty list", ""],
    ["only a separator", ","],
    ["an empty entry", "claude,,codex"],
  ])("rejects %s of providers", async (_label, value) => {
    const s = await inited();
    await expectRefused(s, ["bob", "--separate", "--unix-account", "acct-bob", "--providers", value, "--paseo-version", VERSION], /provider/i);
  });

  it("rejects an unknown provider, names it and lists the known ones", async () => {
    const s = await inited();
    await expectRefused(s, ["bob", "--separate", "--unix-account", "acct-bob", "--providers", "claude,gemini", "--paseo-version", VERSION], "gemini", "opencode");
  });

  it("does not normalise provider ids: a different case is unknown", async () => {
    const s = await inited();
    await expectRefused(s, ["bob", "--separate", "--unix-account", "acct-bob", "--providers", "Claude", "--paseo-version", VERSION], "Claude");
  });

  it("rejects a duplicate provider", async () => {
    const s = await inited();
    await expectRefused(s, ["bob", "--separate", "--unix-account", "acct-bob", "--providers", "claude,claude", "--paseo-version", VERSION], /duplicate provider/);
  });

  it("needs a paseo version when none is stored", async () => {
    const s = await inited();
    await expectRefused(s, ["bob", "--separate", "--unix-account", "acct-bob", "--providers", "claude"], "--paseo-version");
  });

  it.each(["^0.17.4", "~0.17.4", ">=0.17.4", "0.17", "0.17.x", "latest", "v0.17.4", "0.17.4 ", "01.2.3", "0.17.4+build"])(
    "rejects the version %j: exact x.y.z only, no range, tag or build metadata",
    async (version) => {
      const s = await inited();
      const r = await expectRefused(s, ["bob", "--separate", "--unix-account", "acct-bob", "--providers", "claude", "--paseo-version", version], /paseo-?version/i);
      expect(r.err).toContain(version.trim());
    },
  );

  it("refuses a --paseo-version that differs from the stored one: one pinned version for every separate person", async () => {
    const s = await inited();
    await s.run(["add", "bob", ...SEP_FLAGS]);
    await expectRefused(s, ["cy", "--separate", "--unix-account", "acct-cy", "--providers", "codex", "--paseo-version", "0.18.0"], /paseo-?version/i, VERSION);
  });

  it.each([
    ["an upper-case account name", "Bad"],
    ["an account name with a space", "bad name"],
    ["an account name with a slash", "../x"],
  ])("rejects %s", async (_label, account) => {
    const s = await inited();
    await expectRefused(s, ["bob", "--separate", "--unix-account", account, "--providers", "claude", "--paseo-version", VERSION], /unixAccount/);
  });

  it("rejects the root account", async () => {
    const s = await inited();
    await expectRefused(s, ["bob", "--separate", "--unix-account", "root", "--providers", "claude", "--paseo-version", VERSION], /root/);
  });

  it("rejects an account whose home would be the operator's home (the invalid result is caught by validation)", async () => {
    const s = await inited();
    // Detected userHome is /home/tester and unixAccountHomeBase defaults to /home.
    await expectRefused(s, ["bob", "--separate", "--unix-account", "tester", "--providers", "claude", "--paseo-version", VERSION], /account home/, "/home/tester");
  });

  it("rejects a unix account that another person already uses", async () => {
    const s = await inited();
    await s.run(["add", "bob", ...SEP_FLAGS]);
    await expectRefused(s, ["cy", "--separate", "--unix-account", "acct-bob", "--providers", "claude"], /duplicate unixAccount/);
  });

  it("rejects a duplicate person name", async () => {
    const s = await inited();
    await s.run(["add", "bob", ...SEP_FLAGS]);
    await expectRefused(s, ["bob", "--separate", "--unix-account", "acct-other", "--providers", "claude"], /duplicate person name/);
  });

  it("rejects Paseo's default port without allowDefaultPort, and a port that is not a number", async () => {
    const s = await inited();
    await expectRefused(s, ["bob", ...SEP_FLAGS, "--port", "6767"], /port 6767/);
    await expectRefused(s, ["bob", ...SEP_FLAGS, "--port", "x"], /--port/);
  });

  it("rejects --shared together with --separate", async () => {
    const s = await inited();
    await expectRefused(s, ["bob", "--shared", ...SEP_FLAGS], "--shared", "--separate");
  });

  it.each([
    ["--providers", "claude"],
    ["--unix-account", "acct-bob"],
    ["--paseo-version", VERSION],
  ])("%s is only valid with --separate: it is refused, not ignored, on a shared person", async (flag, value) => {
    const s = await inited();
    await expectRefused(s, ["ann", "--shared", flag, value], flag, "--separate");
  });

  it("a flag without its value is a usage error", async () => {
    const s = await inited();
    await expectRefused(s, ["bob", "--separate", "--unix-account", "acct-bob", "--paseo-version", VERSION, "--providers"], "--providers");
  });

  it("choosing neither --shared nor --separate is refused and names both", async () => {
    const s = await inited();
    await expectRefused(s, ["bob"], "--shared", "--separate");
  });

  it("still needs an initialised config", async () => {
    const s = await sandbox();
    const r = await s.run(["add", "bob", ...SEP_FLAGS]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("paseo-users init");
    await expect(stat(s.configFile)).rejects.toThrow();
  });
});

describe("help", () => {
  it("documents the separate flags and no longer says add --separate is not implemented", async () => {
    const s = await sandbox();
    const h = await s.run(["help"]);
    for (const flag of ["--separate", "--unix-account", "--providers", "--paseo-version"]) expect(h.out).toContain(flag);
    expect(h.out).not.toContain("not implemented");
  });
});

describe("list shows the mode", () => {
  it("says separate for a separate person, shared for same-user, and unix-account for a host-binary account", async () => {
    const s = await sandbox();
    await writeJson(s.configFile, mixedConfig());
    const query = new FakeQuery(() => ({ code: 0, stdout: "active\n" }));
    const r = await s.run(["list"], { query });
    expect(r.err).toBe("");
    expect(r.out).toContain("ann\tshared\t7100\tactive");
    expect(r.out).toContain("bob\tseparate\t7101\tunknown");
    expect(r.out).toContain("cy\tunix-account\t7102\tunknown");
    expect(r.out).toContain("dee\tseparate\t7103\tunknown");
    // Another account's user manager is not visible from here: only the same-user daemon is asked, and only read-only.
    expect(query.calls).toEqual([["systemctl", "--user", "is-active", "paseo-ann.service"]]);
    expect(s.runner.calls).toEqual([]);
  });

  it("--json carries mode separate and keeps isolation unix-account", async () => {
    const s = await sandbox();
    await writeJson(s.configFile, mixedConfig());
    const rows = JSON.parse((await s.run(["list", "--json"])).out) as { name: string; isolation: string; mode: string; port: number; state: string }[];
    const by = Object.fromEntries(rows.map((x) => [x.name, x]));
    expect(by.ann).toMatchObject({ isolation: "same-user", mode: "shared" });
    expect(by.bob).toMatchObject({ isolation: "unix-account", mode: "separate", port: 7101, state: "unknown" });
    expect(by.cy).toMatchObject({ isolation: "unix-account", mode: "unix-account" });
    expect(by.dee).toMatchObject({ isolation: "unix-account", mode: "separate" });
  });

  it("a person added with add --separate is listed as separate", async () => {
    const s = await inited();
    await s.run(["add", "bob", ...SEP_FLAGS]);
    const r = await s.run(["list"]);
    expect(r.out).toContain("bob\tseparate\t7100\tunknown");
  });
});

describe("plan shows the mode and the providers", () => {
  it("the People line of the text plan says separate and names the providers; other people are unchanged", async () => {
    const s = await sandbox();
    await writeJson(s.configFile, mixedConfig());
    const out = (await s.run(["plan"])).out;
    const line = (name: string) => out.split("\n").find((l) => new RegExp(`^  ${name}\\s`).test(l)) ?? "";
    expect(line("bob")).toMatch(/\bseparate\b/);
    expect(line("bob")).toContain("claude");
    expect(line("bob")).toContain("codex");
    expect(line("bob")).not.toContain("opencode");
    expect(line("dee")).toContain("opencode");
    expect(line("ann")).toMatch(/\bsame-user\b/);
    expect(line("ann")).not.toMatch(/separate/);
    expect(line("cy")).toMatch(/\bunix-account\b/);
    expect(line("cy")).not.toMatch(/separate/);
  });

  it("plan --json carries install and providers for a separate person only", async () => {
    const s = await sandbox();
    await writeJson(s.configFile, mixedConfig());
    const json = JSON.parse((await s.run(["plan", "--json"])).out) as { people: Record<string, unknown>[] };
    const by = Object.fromEntries(json.people.map((p) => [p.name as string, p]));
    expect(by.bob).toMatchObject({ install: "separate", providers: ["claude", "codex"] });
    expect(by.dee).toMatchObject({ install: "separate", providers: ["opencode"] });
    for (const n of ["ann", "cy"]) {
      expect(by[n], n).not.toHaveProperty("install");
      expect(by[n], n).not.toHaveProperty("providers");
    }
  });

  it("plan <name> for a separate person shows the install and provider steps and no operator value", async () => {
    const s = await sandbox();
    await writeJson(s.configFile, mixedConfig());
    const r = await s.run(["plan", "bob"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("bob.install-paseo");
    expect(r.out).toContain("bob.install-claude");
    expect(r.out).toContain("bob.install-codex");
    expect(r.out).not.toContain("bob.install-opencode");
    expect(r.out).not.toMatch(/(^|\s)dee\./);
    expect(r.out).not.toContain("same-user.");
    for (const bad of OPERATOR_VALUES) expect(r.out, bad).not.toContain(bad);
  });
});

describe("render: plan.json carries install and providers", () => {
  it("writes install and providers for separate people, and neither key for anyone else", async () => {
    const s = await sandbox();
    await writeJson(s.configFile, mixedConfig());
    expect((await s.run(["render"])).code).toBe(0);
    const plan = JSON.parse(await readFile(join(s.stateRoot, "render", "plan.json"), "utf8")) as Plan;
    const by = Object.fromEntries(plan.people.map((p) => [p.name, p as PlanPerson & { providers?: string[] }]));
    expect(by.bob).toMatchObject({ install: "separate", providers: ["claude", "codex"] });
    expect(by.dee).toMatchObject({ install: "separate", providers: ["opencode"] });
    for (const n of ["ann", "cy"]) {
      expect(by[n], n).not.toHaveProperty("install");
      expect(by[n], n).not.toHaveProperty("providers");
    }
  });

  it("planHost itself describes the providers of a separate person", () => {
    const plan = planHost(parseConfig(mixedConfig()));
    const bob = plan.people.find((p) => p.name === "bob") as (PlanPerson & { providers?: string[] }) | undefined;
    expect(bob?.providers).toEqual(["claude", "codex"]);
    // The array is a copy: changing the plan must not change the config it came from.
    const cfg = parseConfig(mixedConfig());
    const p2 = planHost(cfg).people.find((p) => p.name === "bob") as (PlanPerson & { providers?: string[] }) | undefined;
    p2?.providers?.push("opencode");
    expect(cfg.people.find((p) => p.name === "bob")?.providers).toEqual(["claude", "codex"]);
  });

  it("a separate person's rendered output (plan, script, staged files, notice) names no operator value", async () => {
    const s = await sandbox();
    await writeJson(s.configFile, separateOnlyConfig());
    expect((await s.run(["render"])).code).toBe(0);
    const out = join(s.stateRoot, "render");
    const files = (await walk(out)).filter((f) => !f.includes(`${join(out, "secrets")}/`));
    expect(files.length).toBeGreaterThan(3);
    for (const f of files) {
      const text = await readFile(f, "utf8");
      for (const bad of OPERATOR_VALUES) expect(text, `${f} contains ${bad}`).not.toContain(bad);
    }
  });
});

describe("apply: the staleness check covers install and providers", () => {
  async function rendered(config: Record<string, unknown> = separateOnlyConfig()) {
    const s = await sandbox();
    await writeJson(s.configFile, config);
    expect((await s.run(["render"])).code).toBe(0);
    return s;
  }

  it("applies a separate person's own steps only: the account's installs, nothing of the operator's", async () => {
    const s = await rendered();
    const r = await s.run(["apply", "bob", ...YES], { isRoot: () => true });
    expect(r.err).not.toContain("refusing");
    expect(r.code).toBe(0);
    const cmds = s.runner.calls.map((c) => c.join(" "));
    expect(cmds.length).toBeGreaterThan(3);
    for (const c of s.runner.calls) expect(["sh", "bash", "-c"].some((x) => c.includes(x))).toBe(false);
    for (const bad of OPERATOR_VALUES) expect(cmds.join("\n"), bad).not.toContain(bad);
    expect(cmds.join("\n")).not.toContain("same-user");
    expect(cmds).toContain(
      [
        "runuser", "-u", "acct-bob", "--", "env", "-i", "HOME=/home/acct-bob", "PATH=/usr/local/bin:/usr/bin:/bin",
        "npm", "install", "--global", "--prefix", "/home/acct-bob/.local/npm", `@getpaseo/cli@${VERSION}`,
      ].join(" "),
    );
    expect(cmds.some((c) => c.endsWith(getProvider("claude").npmPackage))).toBe(true);
    expect(cmds.some((c) => c.endsWith(getProvider("codex").npmPackage))).toBe(true);
    expect(cmds.some((c) => c.includes(getProvider("opencode").npmPackage))).toBe(false);
  });

  it("a rendered plan.json whose people lost their providers is stale", async () => {
    const s = await rendered();
    const file = join(s.stateRoot, "render", "plan.json");
    const plan = JSON.parse(await readFile(file, "utf8")) as { people: Record<string, unknown>[] };
    // The rendered plan must carry them in the first place.
    expect(plan.people[0]).toMatchObject({ install: "separate", providers: ["claude", "codex"] });
    delete plan.people[0]?.providers;
    await writeFile(file, `${JSON.stringify(plan, null, 2)}\n`);
    const r = await s.run(["apply", "bob", ...YES], { isRoot: () => true });
    expect(r.code).toBe(2);
    expect(r.err).toContain("out of date");
    expect(s.runner.calls).toEqual([]);
  });

  it("a rendered plan.json whose people lost install is stale", async () => {
    const s = await rendered();
    const file = join(s.stateRoot, "render", "plan.json");
    const plan = JSON.parse(await readFile(file, "utf8")) as { people: Record<string, unknown>[] };
    delete plan.people[0]?.install;
    await writeFile(file, `${JSON.stringify(plan, null, 2)}\n`);
    const r = await s.run(["apply", "bob", ...YES], { isRoot: () => true });
    expect(r.code).toBe(2);
    expect(r.err).toContain("out of date");
    expect(s.runner.calls).toEqual([]);
  });

  it("changing the providers in the config after render is stale, and runs nothing", async () => {
    const s = await rendered();
    await writeJson(s.configFile, withOperatorValues([sepRaw("bob", "acct-bob", ["claude"])]));
    const r = await s.run(["apply", "bob", ...YES], { isRoot: () => true });
    expect(r.code).toBe(2);
    expect(r.err).toContain("out of date");
    expect(s.runner.calls).toEqual([]);
  });

  it("changing paseoVersion in the config after render is stale, and runs nothing", async () => {
    const s = await rendered();
    await writeJson(s.configFile, { ...separateOnlyConfig(), paseoVersion: "0.18.0" });
    const r = await s.run(["apply", "bob", ...YES], { isRoot: () => true });
    expect(r.code).toBe(2);
    expect(r.err).toContain("out of date");
    expect(s.runner.calls).toEqual([]);
  });

  it("the re-render after a stale refusal carries the new providers, and the next apply goes through", async () => {
    const s = await rendered();
    await writeJson(s.configFile, withOperatorValues([sepRaw("bob", "acct-bob", ["opencode"])]));
    expect((await s.run(["apply", "bob", ...YES], { isRoot: () => true })).code).toBe(2);
    const plan = JSON.parse(await readFile(join(s.stateRoot, "render", "plan.json"), "utf8")) as { people: Record<string, unknown>[] };
    expect(plan.people[0]).toMatchObject({ install: "separate", providers: ["opencode"] });
    expect((await s.run(["apply", "bob", ...YES], { isRoot: () => true })).code).toBe(0);
  });
});

describe("notice-<name>.md for a separate person", () => {
  const LEAKS = /\/home|\.local|127\.0\.0|\b71\d\d\b|acct-|svc-|PASEO|password:|operator-secret-dir|\/opt\//;

  async function notices() {
    const s = await sandbox();
    await writeJson(s.configFile, mixedConfig());
    expect((await s.run(["render"])).code).toBe(0);
    const out = join(s.stateRoot, "render");
    const read = (n: string) => readFile(join(out, `notice-${n}.md`), "utf8");
    return { s, out, ann: await read("ann"), bob: await read("bob"), cy: await read("cy"), dee: await read("dee") };
  }

  it("says: own computer account, own installs, own provider logins, own history", async () => {
    const { bob } = await notices();
    expect(bob).toContain("bob");
    expect(bob).toMatch(/own computer account/i);
    expect(bob).toMatch(/own installs?/i);
    expect(bob).toMatch(/own (provider )?logins?/i);
    expect(bob).toMatch(/own (provider )?history/i);
    expect(bob).toContain("What is yours alone");
  });

  it("names exactly the person's listed providers", async () => {
    const { bob, dee } = await notices();
    expect(bob.toLowerCase()).toContain("claude");
    expect(bob.toLowerCase()).toContain("codex");
    expect(bob.toLowerCase()).not.toContain("opencode");
    expect(dee.toLowerCase()).toContain("opencode");
    expect(dee.toLowerCase()).not.toContain("claude");
    expect(dee.toLowerCase()).not.toContain("codex");
  });

  it("does not describe the shared mode and does not offer to 'ask for separation' to someone already separate", async () => {
    const { bob } = await notices();
    expect(bob).not.toContain("owner's logins");
    expect(bob).not.toMatch(/same computer account as the owner/i);
    expect(bob).not.toMatch(/provider history[^\n]*can be seen and imported/i);
    expect(bob).not.toMatch(/set you up as a\s+separate person/i);
  });

  it("contains no host, path, address, port, account name, secret or operator value", async () => {
    const { s, out, bob, dee } = await notices();
    for (const text of [bob, dee]) {
      expect(text).not.toMatch(LEAKS);
      for (const bad of OPERATOR_VALUES) expect(text, bad).not.toContain(bad);
      expect(text).not.toContain(VERSION);
    }
    for (const n of ["bob", "dee"]) {
      const pw = (await readFile(join(out, `secrets/${n}.password`), "utf8")).trim();
      expect(bob + dee).not.toContain(pw);
    }
    expect(s.runner.calls).toEqual([]);
  });

  it("leaves the notices of the other modes as they are", async () => {
    const { ann, cy } = await notices();
    expect(ann).toContain("What is shared");
    expect(ann).toContain("owner's logins");
    expect(cy).toContain("own computer account");
    expect(cy).not.toMatch(/own installs?/i);
    expect(cy).not.toContain("owner's logins");
    for (const text of [ann, cy]) expect(text).not.toMatch(LEAKS);
  });

  it("writeNotices reads install and providers from the plan, writes 0644 files, one per person", async () => {
    const plan = planHost(parseConfig(mixedConfig()));
    const dir = join((await sandbox()).root, "notices");
    await mkdir(dir, { recursive: true });
    const written = await writeNotices(plan, dir);
    expect(written.map((w) => w.split("/").at(-1))).toEqual(["notice-ann.md", "notice-bob.md", "notice-cy.md", "notice-dee.md"]);
    for (const w of written) expect(((await stat(w)).mode & 0o777)).toBe(0o644);
    const bob = await readFile(join(dir, "notice-bob.md"), "utf8");
    expect(bob).toMatch(/own installs?/i);
    expect(bob.toLowerCase()).toContain("claude");
    expect(bob.toLowerCase()).not.toContain("opencode");
  });

  it("fails closed: a separate person in a plan without providers gets no notice at all", async () => {
    const plan = planHost(parseConfig(withOperatorValues([sepRaw("bob", "acct-bob", ["claude"])])));
    const broken = { ...plan, people: plan.people.map((p) => ({ ...p, providers: [] })) } as Plan;
    const dir = join((await sandbox()).root, "notices");
    await mkdir(dir, { recursive: true });
    await expect(writeNotices(broken, dir)).rejects.toThrow(/provider/i);
    expect(await readdir(dir)).toEqual([]);
  });

  it("is also written when the person was added with add --separate", async () => {
    const s = await inited();
    await s.run(["add", "bob", ...SEP_FLAGS]);
    await s.run(["render"]);
    const bob = await readFile(join(s.stateRoot, "render", "notice-bob.md"), "utf8");
    expect(bob).toMatch(/own computer account/i);
    expect(bob).toMatch(/own installs?/i);
  });
});

describe("config rules stay fail-closed when reached through the CLI", () => {
  const people = (extra: Record<string, unknown>) => withOperatorValues([{ ...sepRaw("bob", "acct-bob", ["claude"]), ...extra }]);

  it.each([
    ["an unknown provider", people({ providers: ["gemini"] })],
    ["no providers", people({ providers: [] })],
    ["duplicate providers", people({ providers: ["claude", "claude"] })],
    ["install separate with same-user isolation", people({ isolation: "same-user", unixAccount: undefined })],
    ["a version range", { ...people({}), paseoVersion: "^0.17.4" }],
    ["no paseoVersion", { ...people({}), paseoVersion: undefined }],
  ])("plan refuses a stored config with %s", async (_label, raw) => {
    const s = await sandbox();
    await writeJson(s.configFile, raw);
    const r = await s.run(["plan"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("invalid config");
    expect(s.runner.calls).toEqual([]);
  });

  it("list refuses it too, instead of printing a mode for an invalid person", async () => {
    const s = await sandbox();
    await writeJson(s.configFile, people({ providers: ["gemini"] }));
    const r = await s.run(["list"]);
    expect(r.code).toBe(2);
    expect(r.out).not.toContain("separate");
  });

  it("providers on a person who is not separate is an error, not ignored", async () => {
    const s = await sandbox();
    await writeJson(s.configFile, rawCfg({ people: [{ name: "ann", isolation: "unix-account", unixAccount: "svc-ann", providers: ["claude"] }] }));
    const r = await s.run(["list"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("providers");
  });
});
