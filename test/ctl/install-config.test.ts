import { describe, expect, it } from "vitest";
import { ConfigError, parseConfig } from "../../tools/ctl/config.js";
import { cfg, rawCfg } from "./helpers.js";

/** Every issue of the ConfigError, or throws if parseConfig accepted the config. */
const issuesOf = (raw: unknown): string[] => {
  try {
    parseConfig(raw);
  } catch (e) {
    expect(e).toBeInstanceOf(ConfigError);
    return (e as ConfigError).issues;
  }
  throw new Error("expected ConfigError");
};

/** At least one issue matches. Patterns are specific so zod's "Unrecognized key" cannot satisfy them. */
const fails = (raw: unknown, re: RegExp) => {
  const issues = issuesOf(raw);
  expect(issues.some((i) => re.test(i)), `no issue matched ${re}; got:\n${issues.join("\n")}`).toBe(true);
};

// Literal on purpose: these tests must run (and fail individually) before the catalog module exists.
// A cross-check against the catalog is at the end of the "accepted" block.
const PROVIDER_IDS = ["claude", "codex", "opencode"] as const;

const VERSION = "0.17.4";
const sep = (extra: Record<string, unknown> = {}) => ({
  name: "ann",
  isolation: "unix-account",
  unixAccount: "acct-ann",
  install: "separate",
  providers: ["claude"],
  ...extra,
});
/** A config with one separate person unless overridden. */
const withSep = (person: Record<string, unknown> = {}, top: Record<string, unknown> = {}) =>
  rawCfg({ paseoVersion: VERSION, people: [sep(person)], ...top });

describe("separate install: accepted", () => {
  it("resolves install, providers and paseoVersion", () => {
    const c = parseConfig(withSep({ providers: ["claude", "codex"] }));
    expect(c.paseoVersion).toBe(VERSION);
    const ann = c.people[0];
    expect(ann?.install).toBe("separate");
    expect(ann?.providers).toEqual(["claude", "codex"]);
    expect(ann?.isolation).toBe("unix-account");
    expect(ann?.unixAccount).toBe("acct-ann");
  });

  it("keeps the order the providers were written in", () => {
    expect(parseConfig(withSep({ providers: ["opencode", "claude"] })).people[0]?.providers).toEqual(["opencode", "claude"]);
  });

  it.each([...PROVIDER_IDS])("accepts catalog provider %s", (id: string) => {
    expect(parseConfig(withSep({ providers: [id] })).people[0]?.providers).toEqual([id]);
  });

  it("accepts every catalog provider at once", () => {
    expect(parseConfig(withSep({ providers: [...PROVIDER_IDS] })).people[0]?.providers).toEqual([...PROVIDER_IDS]);
  });

  it.each(["0.17.4", "1.0.0", "10.20.30", "1.0.0-beta.1", "0.18.0-rc1", "2.0.0-alpha"])("accepts exact paseoVersion %s", (v) => {
    expect(parseConfig(withSep({}, { paseoVersion: v })).paseoVersion).toBe(v);
  });

  it("gives each separate person their own provider list", () => {
    const c = parseConfig(
      rawCfg({
        paseoVersion: VERSION,
        people: [sep({ providers: ["claude"] }), sep({ name: "bob", unixAccount: "acct-bob", providers: ["codex", "opencode"] })],
      }),
    );
    expect(c.people.map((p) => p.providers)).toEqual([["claude"], ["codex", "opencode"]]);
  });

  it("accepts exactly the providers in the catalog (config and catalog cannot drift)", async () => {
    const { PROVIDER_IDS: catalog } = await import("../../tools/ctl/providers.js");
    expect([...catalog]).toEqual([...PROVIDER_IDS]);
    for (const id of catalog) expect(parseConfig(withSep({ providers: [id] })).people[0]?.providers).toEqual([id]);
  });

  it("still resolves the port, and the account still needs unixAccount", () => {
    expect(parseConfig(withSep({ port: 7300 })).people[0]?.port).toBe(7300);
    fails(withSep({ unixAccount: undefined }), /requires unixAccount/);
  });
});

describe("separate install: rejected (fail closed)", () => {
  it("requires isolation unix-account", () => {
    fails(withSep({ isolation: "same-user", unixAccount: undefined, acknowledge: ["shared-provider-history"] }), /ann: .*separate.*unix-account/);
  });

  it("requires isolation unix-account when isolation is left at its default", () => {
    fails(
      rawCfg({ paseoVersion: VERSION, people: [{ name: "ann", install: "separate", providers: ["claude"], acknowledge: ["shared-provider-history"] }] }),
      /ann: .*separate.*unix-account/,
    );
  });

  it("requires providers", () => {
    fails(withSep({ providers: undefined }), /ann: .*providers/);
  });

  it("requires providers to be non-empty", () => {
    fails(withSep({ providers: [] }), /ann: .*providers.*(empty|at least one|non-empty)/);
  });

  it.each(["gemini", "paseo", "Claude", "", "claude ", "@openai/codex", "__proto__"])("rejects unknown provider %j and lists the known ones", (id) => {
    fails(withSep({ providers: [id] }), new RegExp(`ann: .*unknown provider.*known: ${PROVIDER_IDS.join(", ")}`));
  });

  it("names the unknown provider in the issue", () => {
    fails(withSep({ providers: ["claude", "gemini"] }), /unknown provider "gemini"/);
  });

  it("rejects duplicate providers for one person", () => {
    fails(withSep({ providers: ["claude", "codex", "claude"] }), /ann: .*duplicate provider.*claude/);
  });

  it("rejects providers that are not an array of strings", () => {
    fails(withSep({ providers: "claude" }), /providers: .*expected/i);
    fails(withSep({ providers: [1] }), /providers\.0: .*expected/i);
  });

  it("requires a top-level paseoVersion", () => {
    fails(rawCfg({ people: [sep()] }), /paseoVersion.*(required|separate)/i);
  });

  it("names the person who needs paseoVersion", () => {
    fails(rawCfg({ people: [sep()] }), /ann/);
  });

  it.each(["^0.17.4", "~0.17.4", ">=0.17.4", "0.17", "0", "0.17.x", "*", "latest", "next", "v0.17.4", " 0.17.4", "0.17.4 ", "0.17.4+build", "1.0.0-", "1.2.3.4", "", "0.17.4 || 0.18.0"])(
    "rejects non-exact paseoVersion %j",
    (v) => {
      fails(withSep({}, { paseoVersion: v }), /paseoVersion.*exact/i);
    },
  );

  it("rejects a paseoVersion that is not a string", () => {
    fails(withSep({}, { paseoVersion: 0.17 }), /paseoVersion: .*expected/i);
    fails(withSep({}, { paseoVersion: null }), /paseoVersion: .*expected/i);
  });

  it("rejects an unknown install value", () => {
    fails(withSep({ install: "docker" }), /install: .*(shared|separate)/);
    fails(withSep({ install: "" }), /install: .*(shared|separate)/);
    fails(withSep({ install: true }), /install: .*(shared|separate)/);
  });
});

describe("paseoVersion prerelease identifiers (SemVer 2.0 section 9)", () => {
  it.each(["1.2.3-01", "1.2.3-rc.01", "1.2.3-00", "1.2.3-0.00", "1.2.3-rc.1.007"])("rejects leading-zero numeric identifier in %j", (v) => {
    fails(withSep({}, { paseoVersion: v }), /paseoVersion.*exact/i);
  });

  it.each(["1.2.3-rc.0", "1.2.3-rc01", "1.2.3-0", "1.2.3-0a", "1.2.3-01a", "1.2.3-alpha.10", "1.2.3--", "1.2.3-0.3.7"])("accepts %j", (v) => {
    expect(parseConfig(withSep({}, { paseoVersion: v })).paseoVersion).toBe(v);
  });
});

describe("account home must not overlap the operator's home", () => {
  const acct = (extra: Record<string, unknown> = {}, top: Record<string, unknown> = {}) => withSep({ unixAccount: "tester", ...extra }, top);

  it("rejects an account home equal to userHome", () => {
    fails(acct(), /ann: account home \/home\/tester .*userHome/);
  });

  it("rejects an account home inside userHome", () => {
    fails(acct({}, { unixAccountHomeBase: "/home/tester/people" }), /ann: account home .*userHome/);
    fails(acct({ unixAccount: "acct-ann" }, { unixAccountHomeBase: "/home/tester/people" }), /ann: account home .*userHome/);
  });

  it("rejects userHome inside an account home", () => {
    fails(rawCfg({ userHome: "/srv/acct-ann/op", unixAccountHomeBase: "/srv", paseoVersion: VERSION, people: [sep()] }), /ann: account home .*userHome/);
  });

  it("rejects an account home equal to or overlapping homeBase", () => {
    fails(acct({ unixAccount: "acct-ann" }, { homeBase: "/home/acct-ann" }), /ann: account home .*homeBase/);
    fails(acct({ unixAccount: "acct-ann" }, { homeBase: "/home/acct-ann/sub" }), /ann: account home .*homeBase/);
    fails(rawCfg({ userHome: "/home/tester", homeBase: "/srv/x", unixAccountHomeBase: "/srv/x", paseoVersion: VERSION, people: [sep({ unixAccount: "y" })] }), /ann: account home .*homeBase/);
  });

  it("applies to unix-account people without install too", () => {
    fails(rawCfg({ people: [{ name: "ann", isolation: "unix-account", unixAccount: "tester" }] }), /ann: account home .*userHome/);
  });

  it("accepts a disjoint account home, including a sibling with a shared name prefix", () => {
    expect(() => parseConfig(withSep())).not.toThrow();
    expect(() => parseConfig(withSep({ unixAccount: "tester2" }))).not.toThrow();
  });
});

describe("shared install", () => {
  const shared = (extra: Record<string, unknown> = {}) => ({ name: "ann", install: "shared", acknowledge: ["shared-provider-history"], ...extra });

  it("is valid with same-user, and resolves exactly like a person with no install field", () => {
    const a = parseConfig(rawCfg({ people: [shared()] }));
    const b = parseConfig(rawCfg({ people: [{ name: "ann", acknowledge: ["shared-provider-history"] }] }));
    expect(a).toEqual(b);
    expect(a.people[0]?.install).toBeUndefined();
    expect(a.paseoVersion).toBeUndefined();
  });

  it("is valid with an explicit same-user isolation", () => {
    expect(() => parseConfig(rawCfg({ people: [shared({ isolation: "same-user" })] }))).not.toThrow();
  });

  it("is rejected with unix-account", () => {
    fails(rawCfg({ people: [shared({ isolation: "unix-account", unixAccount: "acct-ann", acknowledge: undefined })] }), /ann: .*shared.*same-user/);
  });

  it("is rejected with an unknown isolation as well as the unknown isolation error", () => {
    const issues = issuesOf(rawCfg({ people: [shared({ isolation: "container", acknowledge: undefined })] }));
    expect(issues.some((i) => /unknown isolation "container"/.test(i))).toBe(true);
    expect(issues.some((i) => /ann: .*shared.*same-user/.test(i))).toBe(true);
  });
});

describe("providers and paseoVersion on a person who is not separate", () => {
  const ack = ["shared-provider-history"];

  it("rejects providers on a shared person", () => {
    fails(rawCfg({ people: [{ name: "ann", install: "shared", providers: ["claude"], acknowledge: ack }] }), /ann: .*providers.*separate/);
  });

  it("rejects providers on a same-user person with no install field", () => {
    fails(rawCfg({ people: [{ name: "ann", providers: ["claude"], acknowledge: ack }] }), /ann: .*providers.*separate/);
  });

  it("rejects providers on a unix-account person with no install field (never silently ignored)", () => {
    fails(rawCfg({ people: [{ name: "ann", isolation: "unix-account", unixAccount: "acct-ann", providers: ["claude"] }] }), /ann: .*providers.*separate/);
  });

  it("rejects an empty providers list on a person who is not separate, too", () => {
    fails(rawCfg({ people: [{ name: "ann", isolation: "unix-account", unixAccount: "acct-ann", providers: [] }] }), /ann: .*providers.*separate/);
  });

  it("rejects paseoVersion when nobody is separate", () => {
    fails(cfg({ paseoVersion: VERSION }), /paseoVersion.*separate/);
    fails(
      rawCfg({ paseoVersion: VERSION, people: [{ name: "ann", isolation: "unix-account", unixAccount: "acct-ann" }] }),
      /paseoVersion.*separate/,
    );
  });

  it("rejects paseoVersion when the only install is shared", () => {
    fails(
      rawCfg({ paseoVersion: VERSION, people: [{ name: "ann", install: "shared", acknowledge: ["shared-provider-history"] }] }),
      /paseoVersion.*separate/,
    );
  });

  it("accepts paseoVersion as soon as one person is separate, even beside people who are not", () => {
    const c = parseConfig(
      rawCfg({
        paseoVersion: VERSION,
        people: [sep(), { name: "bob", acknowledge: ["shared-provider-history"] }, { name: "cy", isolation: "unix-account", unixAccount: "acct-cy" }],
      }),
    );
    expect(c.paseoVersion).toBe(VERSION);
    expect(c.people.map((p) => p.install)).toEqual(["separate", undefined, undefined]);
    expect(c.people.map((p) => p.providers)).toEqual([["claude"], [], []]);
  });
});

describe("existing configs resolve exactly as before", () => {
  it("a unix-account person with no install field has no install, no providers and no paseoVersion", () => {
    const c = parseConfig(rawCfg({ people: [{ name: "ann", isolation: "unix-account", unixAccount: "acct-ann" }] }));
    const ann = c.people[0];
    expect(ann).toBeDefined();
    expect("install" in (ann ?? {})).toBe(false);
    expect(ann?.providers).toEqual([]);
    expect("paseoVersion" in c).toBe(false);
    expect(c.paseoBinary).toBe("/opt/paseo/bin/paseo");
  });

  it("a same-user person with no install field has no install and no providers", () => {
    const c = parseConfig(cfg());
    for (const p of c.people) {
      expect("install" in p).toBe(false);
      expect(p.providers).toEqual([]);
    }
    expect("paseoVersion" in c).toBe(false);
  });

  it("still requires paseoBinary and userHome even when every person is separate", () => {
    const { paseoBinary: _drop, ...rest } = withSep() as Record<string, unknown>;
    fails(rest, /paseoBinary/);
  });
});

describe("collects every issue, like the rest of the config", () => {
  it("reports each separate-install problem in one ConfigError", () => {
    const issues = issuesOf(
      rawCfg({
        paseoVersion: "^0.17.4",
        people: [
          { name: "ann", install: "separate", providers: ["claude", "claude", "gemini"], acknowledge: ["shared-provider-history"] },
          { name: "bob", isolation: "unix-account", unixAccount: "acct-bob", install: "shared", providers: ["codex"] },
          { name: "cy", isolation: "unix-account", unixAccount: "acct-cy", install: "separate", providers: [] },
        ],
      }),
    );
    const has = (re: RegExp) => issues.some((i) => re.test(i));
    expect(has(/ann: .*separate.*unix-account/)).toBe(true);
    expect(has(/ann: .*duplicate provider/)).toBe(true);
    expect(has(/unknown provider "gemini"/)).toBe(true);
    expect(has(/bob: .*shared.*same-user/)).toBe(true);
    expect(has(/bob: .*providers.*separate/)).toBe(true);
    expect(has(/cy: .*providers/)).toBe(true);
    expect(has(/paseoVersion.*exact/i)).toBe(true);
  });

  it("reports a separate-install problem together with an unrelated config problem", () => {
    const issues = issuesOf(withSep({ providers: [] }, { listenAddress: "0.0.0.0" }));
    expect(issues.some((i) => /allowAllInterfaces/.test(i))).toBe(true);
    expect(issues.some((i) => /ann: .*providers/.test(i))).toBe(true);
  });

  it("leaves the shared-provider-history acknowledgement rule unchanged for same-user neighbours of a separate person", () => {
    fails(rawCfg({ paseoVersion: VERSION, people: [sep(), { name: "bob" }] }), /bob: same-user people share/);
    expect(() => parseConfig(rawCfg({ paseoVersion: VERSION, people: [sep(), { name: "bob", acknowledge: ["shared-provider-history"] }] }))).not.toThrow();
  });

  it("a separate person needs no acknowledgement of its own", () => {
    expect(() => parseConfig(withSep())).not.toThrow();
    expect(() => parseConfig(rawCfg({ paseoVersion: VERSION, people: [sep(), sep({ name: "bob", unixAccount: "acct-bob" })] }))).not.toThrow();
  });
});
