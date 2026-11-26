import { posix } from "node:path";
import { z } from "zod";
import { DEFAULT_ISOLATION, defaultRegistry } from "./isolation/registry.js";
import type { IsolationRegistry } from "./isolation/index.js";

/** Paseo's default daemon port. A person's daemon there would collide with, or be mistaken for, the existing daemon. */
export const DEFAULT_PASEO_PORT = 6767;

const SAFE_PATH = /^\/[A-Za-z0-9._+@/-]*$/;
const PERSON_NAME = /^[a-z][a-z0-9_-]{1,31}$/;
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

const port = z.number().int().min(1024, "port must be >= 1024").max(65535);

const PersonSchema = z
  .object({
    name: z.string().regex(PERSON_NAME, "name must match ^[a-z][a-z0-9_-]{1,31}$"),
    isolation: z.string().default(DEFAULT_ISOLATION),
    port: port.optional(),
    unixAccount: z.string().regex(UNIX_NAME, "unixAccount must be a portable POSIX user name").optional(),
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
    /**
     * PATH for same-user daemons, as a colon-separated list of absolute directories. systemd user
     * units start with a minimal PATH, so without this the daemon may not find provider CLIs
     * (claude, codex, git). Copy it from your existing daemon's unit. Not applied to unix-account units.
     */
    environmentPath: z.string().regex(ENV_PATH, "environmentPath must be absolute directories separated by ':' (or start with %h), with no spaces, quotes, other '%' or empty entries").optional(),
    /** Parent of unix-account homes. */
    unixAccountHomeBase: absPath("unixAccountHomeBase").default("/home"),
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
}

export interface ResolvedConfig {
  userHome: string;
  listenAddress: string;
  paseoBinary: string;
  homeBase: string;
  environmentPath?: string;
  unixAccountHomeBase: string;
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
    return { name: p.name, isolation: p.isolation, port: assigned, ...(p.unixAccount ? { unixAccount: p.unixAccount } : {}) };
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
    unixAccountHomeBase: c.unixAccountHomeBase,
    allowAllInterfaces: c.allowAllInterfaces,
    allowDefaultPort: c.allowDefaultPort,
    existingDaemons: c.existingDaemons,
    people,
  };

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
  }
  for (const h of dupes(homes)) issues.push(`duplicate PASEO_HOME: ${h}`);

  if (issues.length > 0) throw new ConfigError(issues);
  return ctx;
}
