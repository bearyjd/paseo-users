import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FakeQuery, sandbox, writeJson } from "./cli-helpers.js";
import { cfg, rawCfg } from "./helpers.js";

const mode = async (p: string) => (await stat(p)).mode & 0o777;
const YES = ["--yes", "--i-understand-this-changes-the-host"];

async function ready(extra: Parameters<typeof sandbox>[0] = {}) {
  const s = await sandbox(extra);
  expect((await s.run(["init", "--listen", "127.0.0.1"])).code).toBe(0);
  expect((await s.run(["add", "ann", "--shared"])).code).toBe(0);
  expect((await s.run(["add", "bob", "--shared", "--acknowledge-shared-history"])).code).toBe(0);
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

describe("init", () => {
  it("creates the config from detected values with dir 0700 and file 0600", async () => {
    const s = await sandbox({ detected: { userHome: "/home/tester", paseoBinary: "/opt/paseo/bin/paseo", environmentPath: "/usr/bin:/bin" } });
    const r = await s.run(["init", "--listen", "127.0.0.1", "--port", "7200", "--existing", "main:7000", "--web-ui"]);
    expect(r.code).toBe(0);
    expect(await mode(s.configFile)).toBe(0o600);
    expect(await mode(join(s.configFile, ".."))).toBe(0o700);
    expect(JSON.parse(await readFile(s.configFile, "utf8"))).toEqual({
      userHome: "/home/tester",
      listenAddress: "127.0.0.1",
      basePort: 7200,
      paseoBinary: "/opt/paseo/bin/paseo",
      environmentPath: "/usr/bin:/bin",
      webUi: true,
      existingDaemons: [{ name: "main", port: 7000 }],
      people: [],
    });
    expect(r.out).toContain("host was not changed");
  });

  it("flags override detection, and --listen is required unless detected", async () => {
    const s = await sandbox();
    const none = await s.run(["init"]);
    expect(none.code).toBe(2);
    expect(none.err).toContain("--listen");
    const ok = await s.run(["init", "--listen", "10.0.0.5", "--paseo-binary", "/usr/local/bin/paseo", "--path", "%h/.local/bin:/usr/bin"]);
    expect(ok.code).toBe(0);
    const stored = JSON.parse(await readFile(s.configFile, "utf8"));
    expect(stored.paseoBinary).toBe("/usr/local/bin/paseo");
    expect(stored.environmentPath).toBe("%h/.local/bin:/usr/bin");
    const s2 = await sandbox({ detected: { userHome: "/home/tester", paseoBinary: "/opt/p/paseo", listenAddress: "127.0.0.1" } });
    expect((await s2.run(["init"])).code).toBe(0);
  });

  it("refuses without paseo or HOME, and rejects invalid values without writing", async () => {
    const s = await sandbox({ detected: { userHome: "/home/tester" } });
    expect((await s.run(["init", "--listen", "127.0.0.1"])).err).toContain("--paseo-binary");
    const s2 = await sandbox({ detected: { paseoBinary: "/opt/p/paseo" } });
    expect((await s2.run(["init", "--listen", "127.0.0.1"])).err).toContain("HOME");
    const s3 = await sandbox();
    const bad = await s3.run(["init", "--listen", "0.0.0.0"]);
    expect(bad.code).toBe(2);
    expect(bad.err).toContain("allowAllInterfaces");
    await expect(stat(s3.configFile)).rejects.toThrow();
    expect((await s3.run(["init", "--listen", "127.0.0.1", "--existing", "nope"])).code).toBe(2);
  });

  it("refuses to overwrite an existing config unless --force", async () => {
    const s = await sandbox();
    await s.run(["init", "--listen", "127.0.0.1"]);
    await s.run(["add", "ann", "--shared"]);
    const before = await readFile(s.configFile, "utf8");
    const r = await s.run(["init", "--listen", "127.0.0.2"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("--force");
    expect(await readFile(s.configFile, "utf8")).toBe(before);
    expect((await s.run(["init", "--listen", "127.0.0.2", "--force"])).code).toBe(0);
    expect(JSON.parse(await readFile(s.configFile, "utf8")).listenAddress).toBe("127.0.0.2");
  });

  it("--from validates and adopts an existing config unchanged, without touching the host", async () => {
    const s = await sandbox();
    const raw = cfg({ people: [{ name: "ann", port: 7300, acknowledge: ["shared-provider-history"] }, { name: "cy", isolation: "unix-account", unixAccount: "svc-cy" }] });
    const file = await writeJson(join(s.root, "old.json"), raw);
    const r = await s.run(["init", "--from", file]);
    expect(r.code).toBe(0);
    expect(JSON.parse(await readFile(s.configFile, "utf8"))).toEqual(raw);
    expect(await mode(s.configFile)).toBe(0o600);
    expect(s.runner.calls).toEqual([]);
    const list = await s.run(["list"]);
    expect(list.out).toContain("ann\tshared\t7300");
  });

  it("--from rejects an invalid config, names the acknowledgement trade-off, and writes nothing", async () => {
    const s = await sandbox();
    const bad = await writeJson(join(s.root, "bad.json"), rawCfg());
    const r = await s.run(["init", "--from", bad]);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/provider session history/);
    expect(r.err).toContain("acknowledge");
    await expect(stat(s.configFile)).rejects.toThrow();
    expect((await s.run(["init", "--from", join(s.root, "missing.json")])).code).toBe(2);
    await writeFile(join(s.root, "junk.json"), "{nope");
    expect((await s.run(["init", "--from", join(s.root, "junk.json")])).code).toBe(2);
    const good = await writeJson(join(s.root, "good.json"), cfg());
    expect((await s.run(["init", "--from", good, "--listen", "127.0.0.1"])).code).toBe(2);
  });

  it("--config chooses another file and does not chmod an existing directory", async () => {
    const s = await sandbox();
    const file = join(s.root, "elsewhere", "c.json");
    expect((await s.run(["init", "--listen", "127.0.0.1", "--config", file])).code).toBe(0);
    expect(await mode(file)).toBe(0o600);
    await expect(stat(s.configFile)).rejects.toThrow();
    expect((await s.run(["add", "ann", "--shared", "--config", file])).code).toBe(0);
  });
});

describe("detector", () => {
  it("reads only: PATH lookup, HOME and the unit's Environment=PATH=", async () => {
    const { createDetector, parseUnitPath } = await import("../../tools/ctl/detect.js");
    const read: string[] = [];
    const d = createDetector({
      env: { home: "/home/tester", path: "/nope:/opt/bin:relative:/usr/bin" },
      readFile: async (p) => {
        read.push(p);
        return "[Service]\nEnvironment=PASEO_HOME=/x\nEnvironment=PATH=/home/tester/bin:/usr/bin\n";
      },
      isExecutable: async (p) => p === "/opt/bin/paseo" || p === "/usr/bin/paseo",
      unitPath: "/unit/paseo.service",
    });
    expect(await d()).toEqual({ userHome: "/home/tester", paseoBinary: "/opt/bin/paseo", environmentPath: "/home/tester/bin:/usr/bin" });
    expect(read).toEqual(["/unit/paseo.service"]);
    expect(parseUnitPath('Environment="PATH=/a:/b"\n')).toBe("/a:/b");
    expect(parseUnitPath("Environment=FOO=1\n")).toBeUndefined();
    const none = createDetector({ env: {}, readFile: async () => Promise.reject(new Error("x")), isExecutable: async () => false, unitPath: "/u" });
    expect(await none()).toEqual({});
  });
});

describe("add / remove", () => {
  it("round-trips and assigns ports", async () => {
    const s = await sandbox();
    await s.run(["init", "--listen", "127.0.0.1"]);
    const a = await s.run(["add", "ann", "--shared"]);
    expect(a.code).toBe(0);
    expect(a.out).toContain("port 7100");
    expect(a.out).toContain("host was not changed");
    const b = await s.run(["add", "bob", "--shared", "--port", "7150", "--acknowledge-shared-history"]);
    expect(b.out).toContain("port 7150");
    expect(b.out).toContain("ann");
    const stored = JSON.parse(await readFile(s.configFile, "utf8"));
    expect(stored.people.map((p: { name: string }) => p.name)).toEqual(["ann", "bob"]);
    expect(stored.people[0].acknowledge).toEqual(["shared-provider-history"]);
    const r = await s.run(["remove", "bob"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("NOT changed");
    expect(r.out).toContain("revoke");
    expect(JSON.parse(await readFile(s.configFile, "utf8")).people).toHaveLength(1);
    expect(await mode(s.configFile)).toBe(0o600);
    expect(s.runner.calls).toEqual([]);
  });

  it("remove drops paseoVersion when the last separate person goes, and keeps it while one remains", async () => {
    const s = await sandbox();
    const ack = ["shared-provider-history"];
    const sepPerson = (name: string) => ({ name, isolation: "unix-account", unixAccount: `acct-${name}`, install: "separate", providers: ["claude"] });
    const base = { userHome: "/home/tester", listenAddress: "127.0.0.1", basePort: 7100, paseoBinary: "/opt/paseo/bin/paseo", paseoVersion: "0.17.4" };
    await writeJson(s.configFile, { ...base, people: [{ name: "ann", acknowledge: ack }, sepPerson("bob"), sepPerson("cy")] });
    const first = await s.run(["remove", "bob"]);
    expect(first.err).toBe("");
    expect(first.code).toBe(0);
    expect(JSON.parse(await readFile(s.configFile, "utf8")).paseoVersion).toBe("0.17.4");
    const second = await s.run(["remove", "cy"]);
    expect(second.err).toBe("");
    expect(second.code).toBe(0);
    const stored = JSON.parse(await readFile(s.configFile, "utf8"));
    expect("paseoVersion" in stored).toBe(false);
    expect(stored.people.map((p: { name: string }) => p.name)).toEqual(["ann"]);
    expect((await s.run(["add", "dee", "--shared", "--acknowledge-shared-history"])).code).toBe(0);
    expect(s.runner.calls).toEqual([]);
  });

  it("remove drops paseoVersion when the last person overall goes", async () => {
    const s = await sandbox();
    const base = { userHome: "/home/tester", listenAddress: "127.0.0.1", basePort: 7100, paseoBinary: "/opt/paseo/bin/paseo", paseoVersion: "0.17.4" };
    await writeJson(s.configFile, { ...base, people: [{ name: "bob", isolation: "unix-account", unixAccount: "acct-bob", install: "separate", providers: ["claude"] }] });
    expect((await s.run(["remove", "bob"])).code).toBe(0);
    expect("paseoVersion" in JSON.parse(await readFile(s.configFile, "utf8"))).toBe(false);
    expect((await s.run(["add", "ann", "--shared"])).code).toBe(0);
  });

  it("refuses a second shared person without the acknowledgement, and writes nothing", async () => {
    const s = await sandbox();
    await s.run(["init", "--listen", "127.0.0.1"]);
    expect((await s.run(["add", "ann", "--shared"])).code).toBe(0);
    const before = await readFile(s.configFile, "utf8");
    const r = await s.run(["add", "bob", "--shared"]);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/provider session history and project directories/);
    expect(r.err).toContain("--acknowledge-shared-history");
    expect(await readFile(s.configFile, "utf8")).toBe(before);
    expect((await s.run(["add", "bob", "--shared", "--acknowledge-shared-history"])).code).toBe(0);
  });

  it("a person next to an --existing daemon needs the acknowledgement too", async () => {
    const s = await sandbox();
    await s.run(["init", "--listen", "127.0.0.1", "--existing", "main:6767"]);
    expect((await s.run(["add", "ann", "--shared"])).code).toBe(2);
    expect((await s.run(["add", "ann", "--shared", "--acknowledge-shared-history"])).code).toBe(0);
  });

  it("--separate alone is refused for the missing account and providers (no longer a placeholder), and a bare add is refused", async () => {
    const s = await sandbox();
    await s.run(["init", "--listen", "127.0.0.1"]);
    const before = await readFile(s.configFile, "utf8");
    const r = await s.run(["add", "ann", "--separate"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("--unix-account");
    expect(r.err).not.toContain("not implemented");
    expect(await readFile(s.configFile, "utf8")).toBe(before);
    expect((await s.run(["add", "ann"])).code).toBe(2);
    expect(await readFile(s.configFile, "utf8")).toBe(before);
  });

  it("rejects bad names, duplicates, unknown people and a missing config", async () => {
    const s = await sandbox();
    expect((await s.run(["add", "ann", "--shared"])).err).toContain("paseo-users init");
    await s.run(["init", "--listen", "127.0.0.1"]);
    expect((await s.run(["add", "Bad", "--shared"])).code).toBe(2);
    await s.run(["add", "ann", "--shared"]);
    expect((await s.run(["add", "ann", "--shared", "--acknowledge-shared-history"])).err).toContain("duplicate person name");
    expect((await s.run(["add", "cy", "--shared", "--port", "x"])).code).toBe(2);
    expect((await s.run(["remove", "zed"])).code).toBe(2);
    expect((await s.run(["remove"])).code).toBe(2);
  });
});

describe("list", () => {
  it("reports active, inactive, failure and unknown states, read-only", async () => {
    const answers: Record<string, { code: number; stdout: string } | Error> = {
      "paseo-ann.service": { code: 0, stdout: "active\n" },
      "paseo-bob.service": { code: 3, stdout: "inactive\n" },
      "paseo-cy.service": new Error("spawn failed"),
      "paseo-dee.service": { code: 1, stdout: "garbage" },
    };
    const query = new FakeQuery((argv) => answers[argv[3] as string] ?? { code: 4, stdout: "" });
    const s = await sandbox({ query });
    await s.run(["init", "--listen", "127.0.0.1"]);
    for (const n of ["ann", "bob", "cy", "dee"]) await s.run(["add", n, "--shared", "--acknowledge-shared-history"]);
    const r = await s.run(["list"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("ann\tshared\t7100\tactive");
    expect(r.out).toContain("bob\tshared\t7101\tinactive");
    expect(r.out).toContain("cy\tshared\t7102\tunknown");
    expect(r.out).toContain("dee\tshared\t7103\tunknown");
    expect(query.calls[0]).toEqual(["systemctl", "--user", "is-active", "paseo-ann.service"]);
    expect(query.calls.every((c) => c[0] === "systemctl" && c[2] === "is-active")).toBe(true);
    const json = JSON.parse((await s.run(["list", "--json"])).out);
    expect(json.map((p: { state: string }) => p.state)).toEqual(["active", "inactive", "unknown", "unknown"]);
    expect(s.runner.calls).toEqual([]);
  });

  it("prints unknown without a query runner, and handles an empty config and unix-account people", async () => {
    const s = await sandbox();
    await s.run(["init", "--listen", "127.0.0.1"]);
    expect((await s.run(["list"])).out).toContain("No people yet");
    expect(JSON.parse((await s.run(["list", "--json"])).out)).toEqual([]);
    await writeJson(s.configFile, cfg({ people: [{ name: "ann" }, { name: "cy", isolation: "unix-account", unixAccount: "svc-cy" }] }));
    const query = new FakeQuery(() => ({ code: 0, stdout: "active\n" }));
    const r = await s.run(["list"], { query });
    expect(r.out).toContain("cy\tunix-account\t7101\tunknown");
    expect(r.out).toContain("ann\tshared\t7100\tunknown".replace("unknown", "active"));
    expect(query.calls).toHaveLength(1);
    expect((await s.run(["list"])).out).toContain("ann\tshared\t7100\tunknown");
  });
});

describe("plan / render / revoke-plan on the stored config", () => {
  it("plan uses the stored config; plan <name> shows only that person's and shared prerequisite steps", async () => {
    const s = await ready();
    const all = await s.run(["plan"]);
    expect(all.out).toContain("ann.unit");
    expect(all.out).toContain("bob.unit");
    const one = await s.run(["plan", "bob"]);
    expect(one.code).toBe(0);
    expect(one.out).toContain("bob.unit");
    expect(one.out).toContain("same-user.homebase");
    expect(one.out).not.toContain("ann.unit");
    expect(one.out).not.toMatch(/\bann\.[a-z]/);
    const json = JSON.parse((await s.run(["plan", "bob", "--json"])).out);
    expect(json.people.map((p: { name: string }) => p.name)).toEqual(["bob"]);
    expect(json.steps.every((st: { id: string }) => st.id.startsWith("bob.") || st.id.startsWith("same-user."))).toBe(true);
    expect((await s.run(["plan", "zed"])).code).toBe(2);
  });

  it("is still validated against the whole config", async () => {
    const s = await ready();
    const raw = JSON.parse(await readFile(s.configFile, "utf8"));
    raw.people[0].port = 7100;
    raw.people.push({ name: "cy", port: 7100, acknowledge: ["shared-provider-history"] });
    await writeJson(s.configFile, raw);
    const r = await s.run(["plan", "ann"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("duplicate port");
  });

  it("fails clearly with no config or no people", async () => {
    const s = await sandbox();
    expect((await s.run(["plan"])).err).toContain("paseo-users init");
    await s.run(["init", "--listen", "127.0.0.1"]);
    expect((await s.run(["plan"])).err).toContain("no people yet");
  });

  it("render defaults to $XDG_STATE_HOME/paseo-users/render (0700), writes notices, prints no password", async () => {
    const s = await ready();
    const r = await s.run(["render"]);
    expect(r.code).toBe(0);
    const out = join(s.stateRoot, "render");
    expect(await mode(out)).toBe(0o700);
    expect(await mode(s.stateRoot)).toBe(0o700);
    expect(await mode(join(out, "secrets/ann.password"))).toBe(0o600);
    const pw = (await readFile(join(out, "secrets/ann.password"), "utf8")).trim();
    expect(r.out + r.err).not.toContain(pw);
    expect(r.out).toContain(`${out}/notice-<name>.md`);
    const files = await readdir(out);
    expect(files).toEqual(expect.arrayContaining(["notice-ann.md", "notice-bob.md", "plan.json", "apply.sh"]));
  });

  it("render --out and --rotate work; revoke-plan <name> uses the stored config", async () => {
    const s = await ready();
    const out = join(s.root, "custom");
    await s.run(["render", "--out", out]);
    const pw = await readFile(join(out, "secrets/ann.password"), "utf8");
    await s.run(["render", "--out", out, "--rotate", "ann"]);
    expect(await readFile(join(out, "secrets/ann.password"), "utf8")).not.toBe(pw);
    const rp = await s.run(["revoke-plan", "bob"]);
    expect(rp.code).toBe(0);
    expect(rp.out).toContain("bob.disable");
    expect((await s.run(["revoke-plan", "zed"])).code).toBe(2);
    expect((await s.run(["revoke-plan"])).code).toBe(2);
  });

  it("notice pages hold the name and plain-language sections, and no secrets, host data or ports", async () => {
    const s = await sandbox();
    await writeJson(s.configFile, cfg({ people: [{ name: "ann" }, { name: "cy", isolation: "unix-account", unixAccount: "svc-cy" }] }));
    await s.run(["render"]);
    const out = join(s.stateRoot, "render");
    const ann = await readFile(join(out, "notice-ann.md"), "utf8");
    const cy = await readFile(join(out, "notice-cy.md"), "utf8");
    expect(ann).toContain("ann");
    for (const w of ["What is yours alone", "LLM accounts", "Provider history", "files on the machine", "Asking for separation"]) {
      expect(ann.toLowerCase()).toContain(w.toLowerCase());
    }
    expect(cy).toContain("own computer account");
    expect(cy).not.toContain("owner's logins");
    for (const text of [ann, cy]) {
      expect(text).not.toMatch(/\/home|127\.0\.0|7100|7101|svc-cy|PASEO|password:/);
    }
    for (const n of ["ann", "cy"]) {
      const pw = (await readFile(join(out, `secrets/${n}.password`), "utf8")).trim();
      expect(ann + cy).not.toContain(pw);
    }
  });
});

describe("apply <name>", () => {
  it("refuses without both flags and never reaches the runner", async () => {
    const s = await ready();
    await s.run(["render"]);
    for (const flags of [[], ["--yes"], ["--i-understand-this-changes-the-host"]]) {
      const r = await s.run(["apply", "ann", ...flags]);
      expect(r.code).toBe(2);
      expect(r.err).toMatch(/refusing/);
    }
    expect(s.runner.calls).toEqual([]);
  });

  it("renders when nothing is rendered, then stops so you can review (no commands run)", async () => {
    const s = await ready();
    const r = await s.run(["apply", "ann", ...YES]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("nothing was rendered yet");
    expect(s.runner.calls).toEqual([]);
    await readFile(join(s.stateRoot, "render", "plan.json"), "utf8");
    // rendered now and current: applies
    expect((await s.run(["apply", "ann", ...YES])).code).toBe(0);
  });

  it("refuses a stale render, re-renders it, and runs nothing", async () => {
    const s = await ready();
    await s.run(["render"]);
    await s.run(["add", "cy", "--shared", "--acknowledge-shared-history"]);
    const r = await s.run(["apply", "ann", ...YES]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("out of date");
    expect(s.runner.calls).toEqual([]);
    expect((await s.run(["apply", "ann", ...YES])).code).toBe(0);
  });

  it("applies only that person's steps (plus shared prerequisites) through the runner", async () => {
    const s = await ready();
    await s.run(["render"]);
    const r = await s.run(["apply", "bob", ...YES]);
    expect(r.code).toBe(0);
    const cmds = s.runner.calls.map((c) => c.join(" "));
    expect(cmds).toEqual([
      "install -d -m 0700 /home/tester/.paseo-people",
      "mkdir -p /home/tester/.config/systemd/user",
      "install -d -m 0700 /home/tester/.paseo-people/bob",
      "install -m 0600 secrets/bob.env /home/tester/.paseo-people/bob.env",
      "install -m 0644 files/home/tester/.config/systemd/user/paseo-bob.service /home/tester/.config/systemd/user/paseo-bob.service",
      "systemctl --user daemon-reload",
      "systemctl --user enable --now paseo-bob.service",
    ]);
    expect(cmds.join("\n")).not.toContain("ann");
    expect(r.out).toContain("ok     bob.enable");
    expect(r.out).not.toContain("ann.");
  });

  it("honours --out, unknown people and a failing step", async () => {
    const s = await ready();
    const out = join(s.root, "mine");
    await s.run(["render", "--out", out]);
    expect((await s.run(["apply", "zed", ...YES, "--out", out])).code).toBe(2);
    expect((await s.run(["apply", ...YES, "--out", out])).code).toBe(2);
    const { FakeRunner } = await import("./helpers.js");
    const failing = new FakeRunner((a) => a[0] === "mkdir");
    const r = await s.run(["apply", "ann", ...YES, "--out", out], { runner: failing });
    expect(r.code).toBe(1);
    expect(r.err).toContain("FAILED at same-user.unit-dir");
  });
});

describe("revoke", () => {
  it("renders the revoke plan into its own directory and applies nothing by default", async () => {
    const s = await ready();
    const r = await s.run(["revoke", "bob"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("bob.disable");
    expect(r.out).toContain("Nothing was applied");
    expect(s.runner.calls).toEqual([]);
    expect(await mode(join(s.stateRoot, "revoke-bob"))).toBe(0o700);
    expect(await mode(join(s.stateRoot, "revoke-bob", "secrets/bob.password"))).toBe(0o600);
    await expect(stat(join(s.stateRoot, "render"))).rejects.toThrow();
  });

  it("--apply needs both flags, then runs the revoke steps through the runner", async () => {
    const s = await ready();
    for (const flags of [[], ["--yes"]]) {
      const r = await s.run(["revoke", "bob", "--apply", ...flags]);
      expect(r.code).toBe(2);
      expect(r.err).toMatch(/refusing/);
    }
    expect(s.runner.calls).toEqual([]);
    const r = await s.run(["revoke", "bob", "--apply", ...YES]);
    expect(r.code).toBe(0);
    expect(s.runner.calls.map((c) => c.join(" "))).toEqual([
      "systemctl --user disable --now paseo-bob.service",
      "install -m 0600 secrets/bob.env /home/tester/.paseo-people/bob.env",
    ]);
    expect((await s.run(["revoke", "zed"])).code).toBe(2);
  });
});

describe("password", () => {
  const CHOSEN = "correct horse battery staple";

  it("rotates to a new random password and prints the manual steps, not the password", async () => {
    const s = await ready();
    await s.run(["render"]);
    const file = join(s.stateRoot, "render", "secrets/ann.password");
    const before = await readFile(file, "utf8");
    const bobBefore = await readFile(join(s.stateRoot, "render", "secrets/bob.password"), "utf8");
    const r = await s.run(["password", "ann"]);
    expect(r.code).toBe(0);
    const after = await readFile(file, "utf8");
    expect(after).not.toBe(before);
    expect(await readFile(join(s.stateRoot, "render", "secrets/bob.password"), "utf8")).toBe(bobBefore);
    expect(await mode(file)).toBe(0o600);
    expect(r.out).toContain("systemctl --user restart paseo-ann.service");
    expect(r.out).toContain("install -m 0600 secrets/ann.env /home/tester/.paseo-people/ann.env");
    expect(r.out).toContain("paseo-users apply ann --yes --i-understand-this-changes-the-host");
    expect(r.out + r.err).not.toContain(after.trim());
    expect(s.runner.calls).toEqual([]);
  });

  it("--stdin keeps a chosen passphrase across re-render and never prints or leaks it", async () => {
    const s = await ready({ stdin: [`${CHOSEN}\n`.replace("\n", "")] });
    const r = await s.run(["password", "ann", "--stdin"]);
    expect(r.code).toBe(0);
    const out = join(s.stateRoot, "render");
    expect((await readFile(join(out, "secrets/ann.password"), "utf8")).trim()).toBe(CHOSEN);
    expect(await readFile(join(out, "secrets/ann.env"), "utf8")).toBe(`PASEO_PASSWORD=${CHOSEN}\n`);
    expect(await mode(join(out, "secrets/ann.env"))).toBe(0o600);
    const again = await s.run(["render"]);
    expect(again.out).toContain("kept passwords: ann, bob");
    expect((await readFile(join(out, "secrets/ann.password"), "utf8")).trim()).toBe(CHOSEN);
    expect((await s.run(["render", "--out", out, "--rotate", "bob"])).code).toBe(0);
    expect((await readFile(join(out, "secrets/ann.password"), "utf8")).trim()).toBe(CHOSEN);
    expect(r.out + r.err + again.out + again.err).not.toContain(CHOSEN);
    for (const f of await walk(out)) {
      if (f.includes("/secrets/")) continue;
      expect(await readFile(f, "utf8"), f).not.toContain(CHOSEN);
    }
    expect(await readFile(join(out, "plan.json"), "utf8")).not.toContain(CHOSEN);
    expect(s.runner.calls).toEqual([]);
  });

  it("rejects short, name-equal, odd-character and missing passphrases without changing anything", async () => {
    const s = await ready({ stdin: ["short", "has a 'quote' in it ok", " leading space here", "has \\ backslash here"] });
    await s.run(["render"]);
    const file = join(s.stateRoot, "render", "secrets/ann.password");
    const before = await readFile(file, "utf8");
    for (const want of [/at least 12/, /quotes/, /whitespace/, /quotes, backslash/]) {
      const r = await s.run(["password", "ann", "--stdin"]);
      expect(r.code).toBe(2);
      expect(r.err).toMatch(want);
    }
    expect((await s.run(["password", "ann", "--stdin"])).err).toContain("no passphrase on stdin");
    expect(await readFile(file, "utf8")).toBe(before);
    expect((await s.run(["password", "zed", "--stdin"])).code).toBe(2);
  });

  it("refuses a passphrase equal to the person's name (case-insensitive)", async () => {
    const { passphraseProblem } = await import("../../tools/ctl/passphrase.js");
    expect(passphraseProblem("Alexandria-Bobson", "alexandria-bobson")).toMatch(/name/);
    expect(passphraseProblem("alexandria-bobson!", "alexandria-bobson")).toBeUndefined();
    const s = await sandbox({ stdin: ["longname-person"] });
    await writeJson(s.configFile, cfg({ people: [{ name: "longname-person" }] }));
    expect((await s.run(["password", "longname-person", "--stdin"])).err).toMatch(/name/);
  });

  it("strips a trailing carriage return and takes no passphrase from argv", async () => {
    const s = await ready({ stdin: [`${CHOSEN}\r`] });
    expect((await s.run(["password", "ann", "--stdin"])).code).toBe(0);
    expect((await readFile(join(s.stateRoot, "render", "secrets/ann.password"), "utf8")).trim()).toBe(CHOSEN);
    expect((await s.run(["password", "ann", CHOSEN])).code).toBe(2);
  });
});

describe("legacy file form", () => {
  it("plan, render, revoke-plan and apply <config.json> keep working", async () => {
    const s = await sandbox();
    const file = await writeJson(join(s.root, "config.json"), cfg());
    expect((await s.run(["plan", file])).out).toContain("ann  same-user  port 7100");
    expect((await s.run(["plan", file, "bob"])).out).not.toContain("ann.unit");
    const out = join(s.root, "out");
    expect((await s.run(["render", file])).err).toContain("--out");
    expect((await s.run(["render", file, "--out", out])).code).toBe(0);
    expect((await readdir(out)).includes("notice-ann.md")).toBe(true);
    expect((await s.run(["revoke-plan", file, "bob"])).out).toContain("bob.disable");
    expect((await s.run(["apply", file, "--out", out])).code).toBe(2);
    const r = await s.run(["apply", file, "--out", out, ...YES]);
    expect(r.code).toBe(0);
    expect(s.runner.calls.some((c) => c.join(" ").includes("paseo-ann")) && s.runner.calls.some((c) => c.join(" ").includes("paseo-bob"))).toBe(true);
    await expect(stat(s.configFile)).rejects.toThrow();
  });
});

describe("usage and exit codes", () => {
  it("lists every command in the usage text", async () => {
    const s = await sandbox();
    const h = await s.run(["help"]);
    expect(h.code).toBe(0);
    for (const c of ["init", "add", "remove", "list", "plan", "render", "revoke-plan", "password", "revoke", "apply", "help", "--version"]) {
      expect(h.out).toContain(c);
    }
    expect((await s.run(["--help"])).out).toBe(h.out);
    expect(h.out).toContain("Exit codes");
  });

  it("--version prints the injected version; no args prints usage with 0; unknown command is 2", async () => {
    const s = await sandbox();
    expect((await s.run(["--version"])).out).toBe("9.9.9\n");
    const none = await s.run([]);
    expect(none.code).toBe(0);
    expect(none.err).toContain("paseo-users");
    expect((await s.run(["bogus"])).code).toBe(2);
  });

  it("unknown flags are 2; a file-system failure is 1", async () => {
    const s = await ready();
    expect((await s.run(["list", "--nope"])).code).toBe(2);
    expect((await s.run(["render", "--out"])).code).toBe(2);
    await writeFile(join(s.root, "afile"), "x");
    const r = await s.run(["render", "--out", join(s.root, "afile", "sub")]);
    expect(r.code).toBe(1);
  });

  it("config paths come from XDG or HOME and never from the real environment", async () => {
    const s = await sandbox();
    const viaHome = await s.run(["init", "--listen", "127.0.0.1"], { env: { home: join(s.root, "h2") } });
    expect(viaHome.code).toBe(0);
    expect(await mode(join(s.root, "h2", ".config", "paseo-users", "config.json"))).toBe(0o600);
    const none = await s.run(["list"], { env: {} });
    expect(none.code).toBe(2);
    expect(none.err).toContain("HOME or XDG_CONFIG_HOME");
    const rel = await s.run(["list"], { env: { xdgConfigHome: "relative/dir" } });
    expect(rel.code).toBe(2);
  });
});
