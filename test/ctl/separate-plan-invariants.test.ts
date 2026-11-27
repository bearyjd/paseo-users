import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseConfig, type ResolvedConfig } from "../../tools/ctl/config.js";
import type { Step } from "../../tools/ctl/isolation/index.js";
import { unixAccount } from "../../tools/ctl/isolation/unix-account.js";
import { planForPerson, planHost, planRevoke, type Plan } from "../../tools/ctl/plan.js";
import { getProvider } from "../../tools/ctl/providers.js";
import { stepArgv } from "../../tools/ctl/shell.js";
import { rawCfg } from "./helpers.js";

/**
 * Slice 2, invariants of the unix-account plan for install "separate" (docs/12 section 3).
 * Synthetic values only. Nothing here runs a command: plans are data, rendered and inspected in memory.
 */
const VERSION = "0.17.4";
const USER_HOME = "/home/tester";
const HOST_BINARY = "/opt/paseo/bin/paseo";
const ENV_PATH_PARTS = ["/opt/operator-tools/bin", "operator-secret-dir"];
const ENV_PATH = `%h/operator-secret-dir:${ENV_PATH_PARTS[0]}`;
const SYSTEM_PATH = "/usr/local/bin:/usr/bin:/bin";

const sep = (extra: Record<string, unknown> = {}) => ({
  name: "ann",
  isolation: "unix-account",
  unixAccount: "acct-ann",
  install: "separate",
  providers: ["claude", "codex"],
  ...extra,
});
const bob = () => sep({ name: "bob", unixAccount: "acct-bob", providers: ["opencode"] });
const legacy = () => ({ name: "cy", isolation: "unix-account", unixAccount: "svc-cy" });
const config = (people: Record<string, unknown>[] = [sep(), bob()], extra: Record<string, unknown> = {}) =>
  parseConfig(
    rawCfg({
      // paseoVersion is only valid when somebody is separate (fail closed), so it is not added otherwise.
      ...(people.some((p) => p.install === "separate") ? { paseoVersion: VERSION } : {}),
      environmentPath: ENV_PATH,
      people,
      ...extra,
    }),
  );

const accountHome = (acct: string) => `/home/${acct}`;
/** Command prefix of every account-level command, as the docs/12 section 3 shape. */
const asAcct = (acct: string) => ["runuser", "-u", acct, "--", "env", "-i", `HOME=${accountHome(acct)}`, `PATH=${SYSTEM_PATH}`];
const startsWith = (argv: string[] | undefined, prefix: string[]) => !!argv && prefix.every((x, i) => argv[i] === x);

/** Every string a step carries: description, argv, dir, file path and rendered content. */
const stepText = (s: Step): string =>
  [s.id, s.description, ...(stepArgv(s) ?? []), s.dir?.path, s.dir?.owner, s.file?.path, s.file?.owner, s.file?.content]
    .filter((x): x is string => typeof x === "string")
    .join("\n");

const personSteps = (plan: Plan, name: string) => plan.steps.filter((s) => s.id.startsWith(`${name}.`));
/** The one hand-run check that must name the operator's home: `test ! -r <userHome>`. */
const isHomeCheck = (s: Step) => s.command?.slice(-3).join(" ") === `! -r ${USER_HOME}`;
const homeCheck = (plan: Plan, name: string) => plan.verify.find((s) => s.id.startsWith(`${name}.`) && isHomeCheck(s));

describe("separate install: the account cannot read the operator's home (hand-run verify)", () => {
  const plan = planHost(config());

  it("adds a hand-run check as the account: test ! -r <userHome>", () => {
    const s = homeCheck(plan, "ann");
    expect(s, "ann has a verify step running test ! -r <userHome>").toBeDefined();
    expect(s?.kind).toBe("command");
    expect(s?.privileged).toBe(true);
    expect(s?.command).toEqual([...asAcct("acct-ann"), "test", "!", "-r", USER_HOME]);
    expect(s?.description).toContain("acct-ann");
  });

  it("adds one check per separate person, each as its own account", () => {
    expect(homeCheck(plan, "bob")?.command).toEqual([...asAcct("acct-bob"), "test", "!", "-r", USER_HOME]);
    expect(plan.verify.filter(isHomeCheck)).toHaveLength(2);
  });

  it("is hand-run only: the check is in verify, never in the steps apply runs", () => {
    expect(plan.steps.some((s) => s.command?.includes(USER_HOME))).toBe(false);
    expect(plan.steps.some(isHomeCheck)).toBe(false);
  });

  it("is part of that person's own part of the plan", () => {
    expect(homeCheck(planForPerson(plan, "ann"), "ann")).toBeDefined();
    expect(homeCheck(planForPerson(plan, "ann"), "bob")).toBeUndefined();
  });

  it("is not added for a unix-account person without install, nor for same-user people", () => {
    const p = planHost(config([legacy(), { name: "dee", acknowledge: ["shared-provider-history"] }]));
    expect(p.verify.some((s) => s.command?.includes(USER_HOME))).toBe(false);
  });

  it("the account's paseo check runs the account's own binary and names the pinned version", () => {
    const v = plan.verify.find((s) => s.id === "ann.verify-install");
    expect(v && stepArgv(v)).toEqual([...asAcct("acct-ann"), "/home/acct-ann/.local/npm/bin/paseo", "--version"]);
    expect(v?.privileged).toBe(true);
    expect(v?.description).toContain(VERSION);
  });

  it("names a prerelease pin exactly, in the install step and the verify check", () => {
    const p = planHost(config([sep()], { paseoVersion: "0.18.0-beta.1" }));
    expect(stepArgv(p.steps.find((s) => s.id === "ann.install-paseo") as Step)?.at(-1)).toBe("@getpaseo/cli@0.18.0-beta.1");
    expect(p.verify.find((s) => s.id === "ann.verify-install")?.description).toContain("0.18.0-beta.1");
  });
});

describe("separate install: one manual login step per provider", () => {
  const plan = planHost(config());
  const ids = (name: string) => plan.steps.filter((s) => s.id.startsWith(`${name}.login-`)).map((s) => s.id);

  it("has exactly one per listed provider, in the written order, none for unlisted providers", () => {
    expect(ids("ann")).toEqual(["ann.login-claude", "ann.login-codex"]);
    expect(ids("bob")).toEqual(["bob.login-opencode"]);
  });

  it("is manual with no command, not privileged, naming the account and that provider's loginHint only", () => {
    for (const id of ["claude", "codex"]) {
      const s = plan.steps.find((x) => x.id === `ann.login-${id}`);
      expect(s?.kind, id).toBe("manual");
      expect(s?.command, id).toBeUndefined();
      expect(s && stepArgv(s), id).toBeUndefined();
      expect(s?.privileged, id).toBeFalsy();
      expect(s?.description, id).toContain("acct-ann");
      expect(s?.description, id).toContain(getProvider(id).loginHint);
    }
    const other = plan.steps.find((x) => x.id === "ann.login-claude")?.description ?? "";
    expect(other).not.toContain(getProvider("codex").loginHint);
  });

  it("comes after that provider's install and the daemon start", () => {
    const at = (id: string) => plan.steps.findIndex((s) => s.id === id);
    expect(at("ann.install-claude")).toBeLessThan(at("ann.login-claude"));
    expect(at("ann.install-codex")).toBeLessThan(at("ann.login-codex"));
    expect(at("ann.enable")).toBeLessThan(at("ann.login-claude"));
  });

  it("copies and references no token or credential file", () => {
    for (const s of personSteps(plan, "ann")) {
      expect(stepText(s), s.id).not.toMatch(/token|credential|auth\.json|\.claude|\.codex|\.opencode/i);
      expect(["cp", "mv", "ln", "rsync", "scp", "cat"].includes(stepArgv(s)?.[0] ?? ""), s.id).toBe(false);
    }
  });

  it("is not added for a unix-account person without install", () => {
    const p = planHost(config([legacy()]));
    expect(p.steps.filter((s) => s.id.startsWith("cy.login-"))).toEqual([]);
  });
});

describe("separate install: warnings", () => {
  const warnings = (people: Record<string, unknown>[]) => planHost(config(people)).warnings;

  it("warns that provider CLIs are installed unpinned (latest at install time), naming each separate person", () => {
    const w = warnings([sep(), bob(), legacy()]).find((x) => /unpinned|not pinned/i.test(x));
    expect(w, "an unpinned-provider warning").toBeDefined();
    expect(w).toMatch(/latest/i);
    expect(w).toContain("ann");
    expect(w).toContain("bob");
    expect(w).not.toContain("cy");
  });

  it("warns that each separate person needs their own provider logins, naming them", () => {
    const w = warnings([sep(), legacy()]).find((x) => /separate/i.test(x) && /own login/i.test(x));
    expect(w, "an own-logins warning for separate people").toBeDefined();
    expect(w).toContain("ann");
    expect(w).not.toContain("cy");
  });

  it("adds neither warning when nobody is separate", () => {
    const text = warnings([legacy(), { name: "dee", acknowledge: ["shared-provider-history"] }]).join("\n");
    expect(text).not.toMatch(/unpinned|not pinned/i);
    expect(text).not.toMatch(/separate.*own login/i);
  });

  it("keeps the existing unix-account login warning", () => {
    expect(warnings([sep()]).join("\n")).toMatch(/LLM logins are not shared/);
  });
});

describe("separate install: the plan never contains the operator's paths (one test per invariant)", () => {
  const plan = planHost(config());
  const every = (...parts: Plan[]) => parts.flatMap((p) => [...p.steps, ...p.verify]);
  const revoke = planRevoke(config(), "ann");
  const part = planForPerson(plan, "ann");

  it("no step argv contains userHome, paseoBinary or environmentPath", () => {
    for (const s of every(plan, revoke, part)) {
      if (isHomeCheck(s)) continue; // the one hand-run check that must name userHome
      const argv = (stepArgv(s) ?? []).join("\n");
      expect(argv, s.id).not.toContain(USER_HOME);
      expect(argv, s.id).not.toContain(HOST_BINARY);
      for (const bad of [ENV_PATH, ...ENV_PATH_PARTS]) expect(argv, s.id).not.toContain(bad);
    }
  });

  it("no file content contains userHome, paseoBinary or environmentPath", () => {
    const files = plan.steps.filter((s) => s.file?.content !== undefined);
    expect(files.length).toBeGreaterThan(0);
    for (const s of files) {
      const c = s.file?.content ?? "";
      expect(c, s.id).not.toContain(USER_HOME);
      expect(c, s.id).not.toContain(HOST_BINARY);
      for (const bad of [ENV_PATH, ...ENV_PATH_PARTS]) expect(c, s.id).not.toContain(bad);
    }
  });

  it("no description contains userHome, paseoBinary or environmentPath", () => {
    for (const s of every(plan, revoke, part)) {
      expect(s.description, s.id).not.toContain(USER_HOME);
      expect(s.description, s.id).not.toContain(HOST_BINARY);
      for (const bad of [ENV_PATH, ...ENV_PATH_PARTS]) expect(s.description, s.id).not.toContain(bad);
    }
  });

  it("no dir or file destination, and no warning, contains the operator's paths", () => {
    for (const s of plan.steps) {
      expect(s.dir?.path ?? "", s.id).not.toContain(USER_HOME);
      expect(s.file?.path ?? "", s.id).not.toContain(USER_HOME);
    }
    expect(plan.warnings.join("\n")).not.toContain(USER_HOME);
    expect(plan.warnings.join("\n")).not.toContain(HOST_BINARY);
  });

  it("the unit has no PATH entry and no ExecStart outside the account home", () => {
    const unit = plan.steps.find((s) => s.id === "ann.unit")?.file?.content ?? "";
    const exec = /^ExecStart=(\S+)/m.exec(unit)?.[1];
    expect(exec).toBe("/home/acct-ann/.local/npm/bin/paseo");
    const path = /^Environment=PATH=(.*)$/m.exec(unit)?.[1];
    expect(path).toBe(`/home/acct-ann/.local/npm/bin:${SYSTEM_PATH}`);
    expect(unit).not.toMatch(/%h/);
  });

  it("the unit gets exactly one PATH line and the account's paseo is the only binary it starts", () => {
    const unit = plan.steps.find((s) => s.id === "ann.unit")?.file?.content ?? "";
    expect(unit.match(/^Environment=PATH=/gm)).toHaveLength(1);
    expect(unit.match(/^ExecStart=/gm)).toHaveLength(1);
  });
});

describe("separate install: account-level commands", () => {
  const plan = planHost(config());
  // Commands the plan runs as root or as the invoking user, not as the account.
  const ROOT_ONLY = new Set(["useradd", "passwd", "loginctl", "systemctl", "usermod", "install", "curl", "sudo"]);
  const accountLevel = (plan: Plan, name: string) =>
    [...plan.steps, ...plan.verify].filter((s) => s.id.startsWith(`${name}.`) && s.kind === "command" && !ROOT_ONLY.has(s.command?.[0] ?? ""));

  it("every account-level command starts with runuser -u <acct> -- env HOME=<acctHome> PATH=<system>", () => {
    for (const [name, acct] of [["ann", "acct-ann"], ["bob", "acct-bob"]] as const) {
      const found = accountLevel(plan, name);
      // install-paseo, one install per provider, verify-install, the home check
      expect(found.length, name).toBe(name === "ann" ? 5 : 4);
      for (const s of found) {
        expect(startsWith(s.command, asAcct(acct)), s.id).toBe(true);
        expect(s.privileged, s.id).toBe(true);
      }
    }
  });

  it("only the allowed root commands and runuser are used; nothing else", () => {
    for (const s of [...plan.steps, ...plan.verify]) {
      if (s.kind !== "command") continue;
      const head = s.command?.[0] ?? "";
      expect(ROOT_ONLY.has(head) || head === "runuser", `${s.id}: ${head}`).toBe(true);
    }
  });

  it("a separate account never runs npm as root or as the operator: npm only appears after runuser -u <acct>", () => {
    for (const s of [...plan.steps, ...plan.verify]) {
      const argv = s.command ?? [];
      const i = argv.indexOf("npm");
      if (i < 0) continue;
      expect(argv.slice(0, 4), s.id).toEqual(["runuser", "-u", s.id.startsWith("ann.") ? "acct-ann" : "acct-bob", "--"]);
    }
  });

  it("runs the account's npm with a fixed PATH, never the operator's environment", () => {
    for (const s of plan.steps.filter((x) => x.id.includes(".install-"))) {
      expect(s.command?.[5], s.id).toBe("-i");
      expect(s.command?.[6], s.id).toBe(`HOME=${accountHome(s.id.startsWith("ann.") ? "acct-ann" : "acct-bob")}`);
      expect(s.command?.[7], s.id).toBe(`PATH=${SYSTEM_PATH}`);
    }
  });

  it("no argv element is sh or bash, and none is -c, in steps, verify or revoke", () => {
    const all = [...plan.steps, ...plan.verify, ...planRevoke(config(), "ann").steps, ...planRevoke(config(), "bob").steps];
    for (const s of all) {
      for (const x of stepArgv(s) ?? []) {
        expect(["sh", "bash", "dash", "zsh", "-c"].includes(x), `${s.id}: ${x}`).toBe(false);
      }
    }
  });

  it("every command is an argv array of non-empty strings (no shell string with spaces as argv[0])", () => {
    for (const s of [...plan.steps, ...plan.verify]) {
      if (s.kind !== "command") continue;
      expect(Array.isArray(s.command), s.id).toBe(true);
      expect(s.command?.[0], s.id).not.toMatch(/\s/);
      for (const x of s.command ?? []) expect(x.length, s.id).toBeGreaterThan(0);
    }
  });
});

describe("separate install: step ids", () => {
  const ctx = config([sep(), bob(), legacy()]);
  const plan = planHost(ctx);

  it("every id of a separate person's steps, verify and revoke starts with '<name>.'", () => {
    for (const name of ["ann", "bob"]) {
      expect(personSteps(plan, name).length).toBeGreaterThan(10);
      for (const s of planRevoke(ctx, name).steps) expect(s.id.startsWith(`${name}.`), s.id).toBe(true);
    }
    // Nothing is left over: every plan step and verify step belongs to one of the three people.
    for (const s of [...plan.steps, ...plan.verify]) expect(/^(ann|bob|cy)\./.test(s.id), s.id).toBe(true);
  });

  it("planForPerson returns all of one separate person's steps, and none of another person's", () => {
    const ann = planForPerson(plan, "ann");
    expect(ann.steps.map((s) => s.id)).toEqual(personSteps(plan, "ann").map((s) => s.id));
    expect(ann.steps.map((s) => s.id)).toEqual(expect.arrayContaining(["ann.install-paseo", "ann.install-claude", "ann.install-codex", "ann.login-claude", "ann.login-codex"]));
    expect(ann.steps.some((s) => s.id.startsWith("bob.") || s.id.startsWith("cy."))).toBe(false);
    expect(ann.verify.every((s) => s.id.startsWith("ann."))).toBe(true);
    expect(homeCheck(ann, "ann")).toBeDefined();
  });

  it("ids are unique across people (nothing is silently deduplicated), including a name that prefixes another", () => {
    const p = planHost(config([sep({ name: "ann" }), sep({ name: "anna", unixAccount: "acct-anna" })]));
    const ids = p.steps.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(planForPerson(p, "ann").steps.some((s) => s.id.startsWith("anna."))).toBe(false);
  });

  it("two separate people produce no conflicting duplicate step", () => {
    expect(() => planHost(ctx)).not.toThrow();
  });
});

describe("separate install: fail closed at plan time", () => {
  const ctx = config([sep()]);
  const person = ctx.people[0];
  const withoutVersion = (): ResolvedConfig => {
    const { paseoVersion: _dropped, ...rest } = ctx;
    return rest;
  };

  it("config has the person as separate", () => {
    expect(person?.install).toBe("separate");
  });

  it("the strategy throws (no silent default version) when paseoVersion is missing", () => {
    expect(person).toBeDefined();
    if (!person) return;
    expect(() => unixAccount.plan(person, withoutVersion())).toThrow(/paseoVersion/);
  });

  it("the strategy throws on an empty provider list", () => {
    if (!person) return;
    expect(() => unixAccount.plan({ ...person, providers: [] }, ctx)).toThrow(/provider/);
  });

  it("the strategy throws on an unknown provider, naming it", () => {
    if (!person) return;
    expect(() => unixAccount.plan({ ...person, providers: ["claude", "nope"] }, ctx)).toThrow(/unknown provider "nope"/);
  });

  it("the strategy reports a missing paseoVersion through validate", () => {
    if (!person) return;
    expect(unixAccount.validate(person, withoutVersion()).join("\n")).toMatch(/paseoVersion/);
  });

  it("a separate person's plan never falls back to the host binary when the version is missing", () => {
    if (!person) return;
    let text = "";
    try {
      text = JSON.stringify(unixAccount.plan(person, withoutVersion()));
    } catch {
      return; // throwing is the expected, fail-closed outcome
    }
    expect(text).not.toContain(HOST_BINARY);
  });
});

describe("a unix-account person without install is unchanged", () => {
  // Hashes recorded from origin/main (before any separate-install work) for this exact config and plan.
  const sha = (x: unknown) => createHash("sha256").update(JSON.stringify(x)).digest("hex");
  const ctx = parseConfig(
    rawCfg({
      webUi: true,
      environmentPath: "/opt/operator-tools/bin",
      people: [legacy(), { name: "dee", acknowledge: ["shared-provider-history"] }],
    }),
  );

  it("the host plan is byte-identical to the plan from before the separate install work", () => {
    expect(sha(planHost(ctx))).toBe("efadb55954ed537b94f423ea738513c2fe469b336aaf9871a6b718b5cbaafbb2");
  });

  it("the revoke plan is byte-identical to the plan from before", () => {
    expect(sha(planRevoke(ctx, "cy"))).toBe("57604a228d0230eb7eec1672ccc5d2a01391f57268bd43b31f7c1851cf0aad87");
  });

  it("adding a separate person next to it does not change its steps", () => {
    const alone = planHost(parseConfig(rawCfg({ environmentPath: ENV_PATH, people: [legacy()] })));
    const beside = planHost(config([legacy(), sep()]));
    expect(personSteps(beside, "cy")).toEqual(personSteps(alone, "cy"));
    expect(beside.verify.filter((s) => s.id.startsWith("cy.") && !s.id.includes(".ann."))).toEqual(alone.verify.filter((s) => s.id.startsWith("cy.")));
  });
});

describe("revocation of a separate person is unchanged", () => {
  const sepRevoke = planRevoke(config([sep()]), "ann");
  const hostBinary = planRevoke(parseConfig(rawCfg({ people: [{ ...legacy(), name: "ann", unixAccount: "acct-ann" }] })), "ann");

  it("has the same steps as for a host-binary account: disable, rotate, lock, terminate, note", () => {
    expect(sepRevoke.steps.map((s) => s.id)).toEqual(["ann.disable", "ann.secret-env", "ann.lock-account", "ann.terminate", "ann.revoke-note"]);
    expect(sepRevoke.steps).toEqual(hostBinary.steps);
    expect(sepRevoke.rotate).toEqual(["ann"]);
  });

  it("does not add install, uninstall or logout steps", () => {
    for (const s of sepRevoke.steps) {
      expect((stepArgv(s) ?? []).filter((x) => ["npm", "runuser", "uninstall"].includes(x)), s.id).toEqual([]);
      expect(s.id, s.id).not.toMatch(/install|login|logout/);
    }
  });
});
