import { posix } from "node:path";
import { z } from "zod";
import { DEFAULT_ISOLATION, defaultRegistry } from "./isolation/registry.js";
import type { IsolationRegistry } from "./isolation/index.js";
import { PROVIDER_IDS } from "./providers.js";

/** Paseo's default daemon port. A person's daemon there would collide with, or be mistaken for, the existing daemon. */
export const DEFAULT_PASEO_PORT = 6767;

const SAFE_PATH = /^\/[A-Za-z0-9._+@/-]*$/;
const RESERVED_NAMES: ReadonlySet<string> = new Set(["same-user", "unix-account"]);
export const PERSON_NAME = /^[a-z][a-z0-9_-]{1,31}$/;
const UNIX_NAME = /^[a-z_][a-z0-9_-]{0,31}$/;
// IPv4, hostname, or bracketed IPv6. No whitespace, no systemd specifiers.
const LISTEN = /^(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9.-]+)$/;
const ALL_INTERFACES = new Set(["0.0.0.0", "::", "[::]"]);

const absPath = (what: string) =>
  z
    .string()
    .refine(
      (p) => SAFE_PATH.test(p) && p.length > 1 && posix.normalize(p) === p && !p.endsWith("/"),
      `${what} must be a normalized absolute path using only [A-Za-z0-9._+@/-], not "/"`,
    );

/**
 * Exact version: x.y.z with an optional -prerelease suffix. No ranges, tags, build metadata or whitespace.
 * Prerelease identifiers follow SemVer 2.0 section 9: a numeric identifier has no leading zero.
 */
const PRERELEASE_ID = "(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)";
const EXACT_VERSION = new RegExp(`^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(-${PRERELEASE_ID}(\\.${PRERELEASE_ID})*)?$`);

const port = z.number().int().min(1024, "port must be >= 1024").max(65535);

/** Trade-offs a person can be explicitly accepted for. Unknown values are an error. */
export const ACKNOWLEDGEMENTS = ["shared-provider-history"] as const;
export type Acknowledgement = (typeof ACKNOWLEDGEMENTS)[number];

const PersonSchema = z
  .object({
    name: z
      .string()
      .regex(PERSON_NAME, "name must match ^[a-z][a-z0-9_-]{1,31}$")
      // Step ids are `<name>.<step>`; these prefixes also name the shared prerequisite steps, so a person with one of
      // these names would be pulled into every other person's per-person apply.
      .refine((n) => !RESERVED_NAMES.has(n), "name is reserved"),
    isolation: z.string().default(DEFAULT_ISOLATION),
    port: port.optional(),
    unixAccount: z.string().regex(UNIX_NAME, "unixAccount must be a portable POSIX user name").optional(),
    /**
     * Trade-offs the operator has accepted for this person. A same-user person who has a neighbour (another daemon in
     * `people`, or any `existingDaemons`) must list "shared-provider-history".
     */
    acknowledge: z.array(z.string()).optional(),
    /**
     * Opt-in install mode. "separate" (unix-account only) gives the account its own paseo and provider CLIs, see
     * docs/12-separate-installs-plan.md. "shared" (same-user only) is today's behaviour. Absent keeps today's behaviour.
     */
    install: z.enum(["shared", "separate"]).optional(),
    /** Provider CLIs to install for a separate person. Ids from the provider catalog. */
    providers: z.array(z.string()).optional(),
  })
  .strict();

// One PATH entry: absolute directory, or %h (systemd's specifier for the user's home) followed by
// an optional sub-path. No other specifier, no spaces, quotes or empty entries.
const PATH_SEGMENT = "[A-Za-z0-9_.+@-]+";
const PATH_ENTRY = `(?:%h(?:/${PATH_SEGMENT})*|(?:/${PATH_SEGMENT})+|/)`;
const ENV_PATH = new RegExp(`^${PATH_ENTRY}(?::${PATH_ENTRY})*$`);

export const ConfigSchema = z
  .object({
    userHome: absPath("userHome"),
    listenAddress: z.string().regex(LISTEN, "listenAddress must be an IPv4 address, hostname or bracketed IPv6 address"),
    basePort: port,
    paseoBinary: absPath("paseoBinary"),
    homeBase: absPath("homeBase").optional(),
    /** Exact paseo version installed for every separate person. Required when one exists, an error otherwise. */
    paseoVersion: z.string().optional(),
    /**
     * PATH for same-user daemons, as a colon-separated list of absolute directories. systemd user
     * units start with a minimal PATH, so without this the daemon may not find provider CLIs
     * (claude, codex, git). Copy it from your existing daemon's unit. Not applied to unix-account units.
     */
    environmentPath: z.string().regex(ENV_PATH, "environmentPath must be absolute directories separated by ':' (or start with %h), with no spaces, quotes, other '%' or empty entries").optional(),
    /** Parent of unix-account homes. */
    unixAccountHomeBase: absPath("unixAccountHomeBase").default("/home"),
    /** Serve the bundled web UI from each daemon (PASEO_WEB_UI_ENABLED). The page is public to whoever reaches the port; the API still needs the daemon password. */
    webUi: z.boolean().default(false),
    allowAllInterfaces: z.boolean().default(false),
    allowDefaultPort: z.boolean().default(false),
    /** Informational: daemons that already run. Used only for port collision checks. Never managed. */
    existingDaemons: z.array(z.object({ name: z.string().min(1), port }).strict()).default([]),
    people: z.array(PersonSchema).min(1),
  })
  .strict();

export type RawConfig = z.input<typeof ConfigSchema>;

export interface Person {
  name: string;
  isolation: string;
  /** Resolved: explicit or assigned from basePort. */
  port: number;
  unixAccount?: string;
  /** Set only for a separate install. Absent means today's behaviour (host paseoBinary, or shared). */
  install?: "separate";
  /** Provider ids to install; always empty unless `install` is "separate". */
  providers: string[];
}

export interface ResolvedConfig {
  userHome: string;
  listenAddress: string;
  paseoBinary: string;
  homeBase: string;
  environmentPath?: string;
  /** Present only when at least one person is separate. */
  paseoVersion?: string;
  unixAccountHomeBase: string;
  webUi: boolean;
  allowAllInterfaces: boolean;
  allowDefaultPort: boolean;
  existingDaemons: { name: string; port: number }[];
  people: Person[];
}

export class ConfigError extends Error {
  constructor(readonly issues: string[]) {
    super(`invalid config:\n- ${issues.join("\n- ")}`);
    this.name = "ConfigError";
  }
}

const isInside = (parent: string, child: string) => {
  const rel = posix.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !posix.isAbsolute(rel));
};

function dupes<T>(items: T[]): T[] {
  const seen = new Set<T>();
  const out = new Set<T>();
  for (const i of items) (seen.has(i) ? out : seen).add(i);
  return [...out];
}

/** Parse, validate and resolve (assign ports). Throws ConfigError listing every problem. Fails closed. */
export function parseConfig(raw: unknown, registry: IsolationRegistry = defaultRegistry): ResolvedConfig {
  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ConfigError(parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`));
  }
  const c = parsed.data;
  const issues: string[] = [];

  if (ALL_INTERFACES.has(c.listenAddress) && !c.allowAllInterfaces) {
    issues.push(`listenAddress ${c.listenAddress} listens on every interface; set allowAllInterfaces: true to accept that`);
  }

  const homeBase = c.homeBase ?? posix.join(c.userHome, ".paseo-people");
  const defaultHome = posix.join(c.userHome, ".paseo");
  if (isInside(defaultHome, homeBase)) {
    issues.push(`homeBase ${homeBase} is the default ~/.paseo or inside it; that belongs to the existing daemon`);
  }

  for (const n of dupes(c.people.map((p) => p.name))) issues.push(`duplicate person name: ${n}`);
  for (const a of dupes(c.people.flatMap((p) => (p.unixAccount ? [p.unixAccount] : [])))) {
    issues.push(`duplicate unixAccount: ${a}`);
  }
  for (const p of c.people) {
    if (p.unixAccount === "root") issues.push(`${p.name}: unixAccount must not be root`);
    if (p.port === DEFAULT_PASEO_PORT && !c.allowDefaultPort) {
      issues.push(`${p.name}: port ${DEFAULT_PASEO_PORT} is Paseo's default daemon port; set allowDefaultPort: true to use it`);
    }
  }

  const explicit = c.people.flatMap((p) => (p.port === undefined ? [] : [p.port]));
  for (const pt of dupes(explicit)) issues.push(`duplicate port: ${pt}`);
  const existingPorts = new Set(c.existingDaemons.map((d) => d.port));
  for (const p of c.people) {
    if (p.port !== undefined && existingPorts.has(p.port)) {
      const d = c.existingDaemons.find((e) => e.port === p.port);
      issues.push(`${p.name}: port ${p.port} collides with existing daemon "${d?.name}"`);
    }
  }
  for (const d of dupes(c.existingDaemons.map((e) => e.port))) issues.push(`existingDaemons: duplicate port ${d}`);

  // Assign ports deterministically, in input order, skipping everything already taken.
  const taken = new Set<number>([...explicit, ...existingPorts]);
  if (!c.allowDefaultPort) taken.add(DEFAULT_PASEO_PORT);
  let next = c.basePort;
  const people: Person[] = c.people.map((p) => {
    let assigned = p.port;
    if (assigned === undefined) {
      while (taken.has(next)) next++;
      assigned = next;
      taken.add(next);
    }
    const separate = p.install === "separate";
    return {
      name: p.name,
      isolation: p.isolation,
      port: assigned,
      ...(p.unixAccount ? { unixAccount: p.unixAccount } : {}),
      ...(separate ? { install: "separate" as const } : {}),
      providers: separate ? [...(p.providers ?? [])] : [],
    };
  });
  for (const p of people) {
    if (p.port > 65535) issues.push(`${p.name}: no free port left at or above basePort`);
  }

  const ctx: ResolvedConfig = {
    userHome: c.userHome,
    listenAddress: c.listenAddress,
    paseoBinary: c.paseoBinary,
    homeBase,
    ...(c.environmentPath ? { environmentPath: c.environmentPath } : {}),
    ...(c.paseoVersion !== undefined && c.people.some((p) => p.install === "separate") ? { paseoVersion: c.paseoVersion } : {}),
    unixAccountHomeBase: c.unixAccountHomeBase,
    webUi: c.webUi,
    allowAllInterfaces: c.allowAllInterfaces,
    allowDefaultPort: c.allowDefaultPort,
    existingDaemons: c.existingDaemons,
    people,
  };

  for (const p of c.people) {
    for (const a of p.acknowledge ?? []) {
      if (!(ACKNOWLEDGEMENTS as readonly string[]).includes(a)) {
        issues.push(`${p.name}: unknown acknowledge value "${a}" (known: ${ACKNOWLEDGEMENTS.join(", ")})`);
      }
    }
    const hasNeighbour = c.people.length > 1 || c.existingDaemons.length > 0;
    if (p.isolation === DEFAULT_ISOLATION && hasNeighbour && !(p.acknowledge ?? []).includes("shared-provider-history")) {
      issues.push(
        `${p.name}: same-user people share the Linux user's provider session history and project directories with the other ` +
          `daemons on this machine. Accept that trade-off by adding "acknowledge": ["shared-provider-history"] to ${p.name} ` +
          `(or use: paseo-users add ${p.name} --shared --acknowledge-shared-history)`,
      );
    }
  }

  // Install mode. Everything given for a person who is not separate is an error, never silently ignored.
  for (const p of c.people) {
    if (p.install === "separate") {
      if (p.isolation !== "unix-account") issues.push(`${p.name}: install "separate" requires isolation "unix-account"`);
      if (p.providers === undefined || p.providers.length === 0) {
        issues.push(`${p.name}: install "separate" requires providers, a non-empty list (known: ${PROVIDER_IDS.join(", ")})`);
      }
      for (const id of p.providers ?? []) {
        if (!PROVIDER_IDS.includes(id)) issues.push(`${p.name}: unknown provider "${id}" (known: ${PROVIDER_IDS.join(", ")})`);
      }
      for (const id of dupes(p.providers ?? [])) issues.push(`${p.name}: duplicate provider "${id}"`);
      if (c.paseoVersion === undefined) {
        issues.push(`${p.name}: top-level paseoVersion is required for install "separate" (exact x.y.z)`);
      }
    } else {
      if (p.install === "shared" && p.isolation !== DEFAULT_ISOLATION) {
        issues.push(`${p.name}: install "shared" requires isolation "${DEFAULT_ISOLATION}"`);
      }
      if (p.providers !== undefined) issues.push(`${p.name}: providers is only valid with install "separate"`);
    }
  }
  if (c.paseoVersion !== undefined) {
    if (!EXACT_VERSION.test(c.paseoVersion)) {
      issues.push(`paseoVersion must be an exact version (x.y.z, optional -prerelease), not a range or tag: "${c.paseoVersion}"`);
    }
    if (!c.people.some((p) => p.install === "separate")) {
      issues.push(`paseoVersion is only used by separate installs, but no person has install "separate"`);
    }
  }

  const homes: string[] = [];
  for (const p of people) {
    if (!registry.has(p.isolation)) {
      issues.push(`${p.name}: unknown isolation "${p.isolation}" (known: ${registry.ids().join(", ")})`);
      continue;
    }
    const strategy = registry.get(p.isolation);
    issues.push(...strategy.validate(p, ctx));
    const home = strategy.paseoHome(p, ctx);
    homes.push(home);
    if (isInside(defaultHome, home)) issues.push(`${p.name}: PASEO_HOME ${home} is the default ~/.paseo or inside it`);
    if (p.isolation === "unix-account" && p.unixAccount) {
      // The account home is chowned and (for separate installs) gets its own npm prefix. It must not be, contain or sit
      // inside the operator's home or the same-user homeBase.
      const accountHome = posix.join(c.unixAccountHomeBase, p.unixAccount);
      for (const [label, other] of [["userHome", c.userHome], ["homeBase", homeBase]] as const) {
        if (isInside(accountHome, other) || isInside(other, accountHome)) {
          issues.push(`${p.name}: account home ${accountHome} equals, contains or is inside ${label} ${other}; choose another unixAccount or unixAccountHomeBase`);
        }
      }
    }
  }
  for (const h of dupes(homes)) issues.push(`duplicate PASEO_HOME: ${h}`);

  if (issues.length > 0) throw new ConfigError(issues);
  return ctx;
}
