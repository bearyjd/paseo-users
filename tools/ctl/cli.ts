import { execFile, spawn } from "node:child_process";
import { readFile, realpath, rm, stat } from "node:fs/promises";
import { basename, dirname, join, relative, isAbsolute, resolve } from "node:path";
import { applyPlan, ApplyRefused, type CommandRunner } from "./apply.js";
import { ConfigError, parseConfig, PERSON_NAME, type RawConfig, type ResolvedConfig } from "./config.js";
import type { Detected, Detector } from "./detect.js";
import { sharedLayout } from "./isolation/same-user.js";
import { writeNotices } from "./notice.js";
import { passphraseProblem } from "./passphrase.js";
import { personStepFilter, planForPerson, planHost, planMigrate, planRevoke, type Plan } from "./plan.js";
import { renderPlan, type RenderOptions, type RenderResult } from "./render.js";
import { secretSourceRel, shellQuote, stepArgv } from "./shell.js";
import { defaultConfigPath, ensurePrivateDir, readRawConfig, stateDir, UsageError, writeRawConfig, type HostEnv } from "./store.js";

/** Read-only command runner that captures stdout. Used by `list` only. */
export interface QueryRunner {
  query(argv: string[]): Promise<{ code: number; stdout: string }>;
}

export interface CliIo {
  stdout(text: string): void;
  stderr(text: string): void;
  /** Only used by `apply` and `revoke --apply`. Defaults to a real process runner, so tests must always inject a fake. */
  runner?: CommandRunner;
  isRoot?: () => boolean;
  /** HOME, XDG dirs and PATH, resolved by the wiring code. Nothing else in the tool reads the process environment. */
  env?: HostEnv;
  /** Used by `init` without --from. Absent means nothing is detected. */
  detector?: Detector;
  /** Used by `list`. Absent means every state is "unknown". */
  query?: QueryRunner;
  /** Reads ONE line from stdin (passphrases never come from argv or env). Undefined at end of input. */
  readLine?: () => Promise<string | undefined>;
  version?: string;
}

const USAGE = `paseo-users (formerly paseo-ctl): plan and render one Paseo daemon per person. It never touches a running daemon.

Setup and people (these change only the stored config, never the host):
  init [--from <config.json>] [--listen <addr>] [--port <n>] [--existing <name>:<port>]...
       [--paseo-binary <abs>] [--path <PATH>] [--web-ui] [--force]
  add <name> --shared [--port <n>] [--acknowledge-shared-history]
  add <name> --separate --unix-account <acct> --providers <id,id,...> [--paseo-version <x.y.z>] [--port <n>]
       own computer account and own installs. --paseo-version is exact (no range, no "latest"); it is stored once
       for every separate person and may be left out after the first. Providers: claude, codex, opencode.
       The person logs in to each provider by hand: the plan cannot do it. UNVERIFIED on a real host.
  remove <name>
  list [--json]                people, mode, port and whether the daemon is running (read-only)

Plan and render (the stored config is used; pass --config <file> to use another):
  plan [<name>] [--json]
  render [--out <dir>] [--rotate <name>|all]       default dir: $XDG_STATE_HOME/paseo-users/render
  revoke-plan <name> [--out <dir>] [--json]
  password <name> [--stdin] [--out <dir>]          rotate (random) or set (one line on stdin) a password in the rendered files
  revoke <name> [--out <dir>] [--apply --yes --i-understand-this-changes-the-host]
  migrate <name> [--out <dir>] [--apply --yes --i-understand-this-changes-the-host]
       move a person from the shared install to their own account (config: isolation unix-account, install separate,
       same port). Keeps their Paseo data and password; provider logins start fresh. Default dir: .../migrate-<name>.
       UNVERIFIED on a real host.

Change the host:
  apply <name> --yes --i-understand-this-changes-the-host [--out <dir>]

Older form, still supported (a config file name contains "." or "/"):
  plan <config.json> [--json]
  render <config.json> --out <dir> [--rotate <name>|all]
  revoke-plan <config.json> <name> [--out <dir>] [--json]
  apply <config.json> --out <dir> --yes --i-understand-this-changes-the-host

  help, --help, --version     --config <file> works on every command.
Exit codes: 0 ok, 1 runtime failure, 2 usage, validation or refusal.

apply changes the host (files, systemd, accounts). Read <dir>/apply.sh first. Prefer running it by hand.
`;

export const spawnRunner: CommandRunner = {
  run: (argv, { cwd }) =>
    new Promise((resolve, reject) => {
      const [cmd, ...args] = argv;
      if (!cmd) return reject(new Error("empty command"));
      const child = spawn(cmd, args, { cwd, stdio: "inherit", shell: false });
      child.on("error", reject);
      child.on("close", (code) => resolve({ code: code ?? 1 }));
    }),
};

/** Real read-only query runner. Wired in bin.ts; tests inject a fake. */
export const spawnQuery: QueryRunner = {
  query: (argv) =>
    new Promise((resolve, reject) => {
      const [cmd, ...args] = argv;
      if (!cmd) return reject(new Error("empty command"));
      execFile(cmd, args, { timeout: 5000, encoding: "utf8" }, (err, stdout) => {
        if (err && typeof (err as NodeJS.ErrnoException).code === "string") return reject(err);
        resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout });
      });
    }),
};

interface Parsed {
  positional: string[];
  values: Map<string, string[]>;
  bools: Set<string>;
  value(flag: string): string | undefined;
}

/**
 * A value flag may appear once unless it is listed in `repeatable`: a second value is refused, never last-wins, so a
 * bad earlier value cannot be hidden behind a good later one.
 */
function parseFlags(args: string[], valueFlags: string[], boolFlags: string[], repeatable: string[] = []): Parsed {
  const positional: string[] = [];
  const values = new Map<string, string[]>();
  const bools = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (valueFlags.includes(a)) {
      const v = args[++i];
      if (v === undefined) throw new UsageError(`${a} needs a value`);
      if (values.has(a) && !repeatable.includes(a)) throw new UsageError(`${a} was given more than once: give it once`);
      values.set(a, [...(values.get(a) ?? []), v]);
    } else if (boolFlags.includes(a)) bools.add(a);
    else if (a.startsWith("--")) throw new UsageError(`unknown flag ${a}`);
    else positional.push(a);
  }
  return { positional, values, bools, value: (f) => values.get(f)?.at(-1) };
}

/** A person name never contains "." or "/", so anything that does is a config file path (the older command form). */
const isConfigArg = (a: string | undefined): a is string => a !== undefined && !PERSON_NAME.test(a);

async function loadFile(path: string): Promise<RawConfig> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (e) {
    throw new UsageError(`cannot read ${path}: ${(e as NodeJS.ErrnoException).code ?? "error"}`);
  }
  try {
    return JSON.parse(text) as RawConfig;
  } catch {
    throw new UsageError(`${path} is not valid JSON`);
  }
}

interface Store {
  file: string;
  /** True when the path is the default one, so its directory is ours to keep at 0700. */
  ownDir: boolean;
}

const storeFor = (io: CliIo, p: Parsed): Store => {
  const given = p.value("--config");
  return given ? { file: resolve(given), ownDir: false } : { file: defaultConfigPath(io.env ?? {}), ownDir: true };
};

const requirePeople = (raw: RawConfig): void => {
  if (!raw.people || raw.people.length === 0) throw new UsageError('no people yet: run "paseo-users add <name> --shared"');
};

async function loadStored(store: Store): Promise<ResolvedConfig> {
  const raw = await readRawConfig(store.file);
  requirePeople(raw);
  return parseConfig(raw);
}

function summary(plan: Plan): string {
  const out: string[] = ["People:"];
  for (const p of plan.people) {
    const install = p.install === "separate" ? `  install separate (${(p.providers ?? []).join(", ")})` : "";
    out.push(`  ${p.name}  ${p.isolation}${install}  port ${p.port}  PASEO_HOME ${p.paseoHome}${p.unixAccount ? `  account ${p.unixAccount}` : ""}`);
  }
  if (plan.warnings.length) out.push("", "Warnings:", ...plan.warnings.map((w) => `  ! ${w}`));
  out.push("", "Steps (in order):");
  for (const s of plan.steps) {
    const argv = stepArgv(s);
    out.push(`  [${s.kind}${s.privileged ? ", root" : ""}] ${s.id}: ${s.description}`);
    if (argv && s.kind === "command") out.push(`      ${argv.map(shellQuote).join(" ")}`);
  }
  if (plan.verify.length) {
    out.push("", "Verify by hand afterwards:", ...plan.verify.map((s) => `  ${s.id}: ${s.description}`));
  }
  return `${out.join("\n")}\n`;
}

/** Render the host plan plus a notice page per person. Revoke plans use renderPlan directly (no notices). */
async function renderHost(plan: Plan, out: string, opts: RenderOptions = {}): Promise<RenderResult> {
  const r = await renderPlan(plan, out, opts);
  await writeNotices(plan, r.outDir);
  return r;
}

const renderSummary = (r: RenderResult) =>
  `Rendered to ${r.outDir}\n  new passwords: ${r.generated.join(", ") || "none"}\n  kept passwords: ${r.kept.join(", ") || "none"}\n` +
  "  Passwords are in secrets/<name>.password. Read apply.sh before running anything.\n" +
  `  Notice pages to hand out: ${r.outDir}/notice-<name>.md\n`;

/** Default render directory, created 0700 together with its parent. An explicit --out is used as given. */
async function outDirFor(io: CliIo, p: Parsed, leaf: string): Promise<string> {
  const given = p.value("--out");
  if (given) return given;
  const dir = stateDir(io.env ?? {});
  await ensurePrivateDir(dir);
  const out = join(dir, leaf);
  await ensurePrivateDir(out);
  return out;
}

/** The path with symbolic links resolved as far as it exists; the rest (not created yet) is appended as written. */
async function resolveExisting(path: string): Promise<string> {
  const abs = resolve(path);
  const rest: string[] = [];
  for (let cur = abs; ; ) {
    try {
      return join(await realpath(cur), ...rest.reverse());
    } catch {
      const parent = dirname(cur);
      if (parent === cur) return abs;
      rest.push(basename(cur));
      cur = parent;
    }
  }
}

/**
 * Refuses an output directory that is, or lies below, any of `sources`. migrate moves the old PASEO_HOME while apply.sh and
 * every non-account command still use the output directory as their working directory: one inside the source moves with it.
 * Compared as written and with symbolic links resolved, so a link into the source does not get past it.
 */
async function refuseOutInside(out: string, sources: string[]): Promise<void> {
  const isInside = (parent: string, child: string) => {
    const rel = relative(parent, child);
    return rel === "" || (rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel));
  };
  const outForms = [resolve(out), await resolveExisting(out)];
  for (const source of sources) {
    for (const src of new Set([resolve(source), await resolveExisting(source)])) {
      if (outForms.some((o) => isInside(src, o))) {
        throw new UsageError(`refusing: the output directory ${out} is, or lies inside, ${source}, which migrate moves. Use another --out (or XDG_STATE_HOME)`);
      }
    }
  }
}

/** True when the store is the default config file, the only one the default render directory belongs to. */
function isDefaultStore(io: CliIo, store: Store): boolean {
  try {
    return store.file === resolve(defaultConfigPath(io.env ?? {}));
  } catch {
    return false;
  }
}

/**
 * Deletes the staged password and .env of person names from the default render directory, so a name that is removed
 * and later given to someone else never inherits the previous person's password. Only the default directory is known:
 * one rendered with --out is the operator's to clean. Only the default config owns that directory: editing another
 * --config file must never delete the default config's secrets.
 * "other-config": the edited config is not the default one, nothing was deleted. "unlocated": the state directory
 * cannot be located, nothing was deleted.
 */
async function forgetStagedSecrets(io: CliIo, store: Store, names: string[]): Promise<"deleted" | "other-config" | "unlocated"> {
  if (!isDefaultStore(io, store)) return "other-config";
  let secrets: string;
  try {
    secrets = join(stateDir(io.env ?? {}), "render", "secrets");
  } catch {
    return "unlocated";
  }
  for (const name of names) {
    if (!PERSON_NAME.test(name)) continue;
    await rm(join(secrets, `${name}.password`), { force: true });
    await rm(join(secrets, secretSourceRel(name).replace(/^secrets\//, "")), { force: true });
  }
  return "deleted";
}

/** What decides whether a staged password may carry over to a person of the same name: who they are on the host. */
const personKind = (x: { isolation?: string | undefined; unixAccount?: string | undefined; install?: string | undefined }) =>
  `${x.isolation ?? "same-user"}|${x.unixAccount ?? ""}|${x.install === "separate" ? "separate" : ""}`;

/** Names in `before` that are gone from `after` or became a different kind of person (another account or mode). */
function replacedNames(before: RawConfig, after: RawConfig): string[] {
  const now = new Map((after.people ?? []).map((x) => [x.name, personKind(x)]));
  return (before.people ?? []).filter((x) => now.get(x.name) !== personKind(x)).map((x) => x.name);
}

/** Resolved port of every person in a stored config, or undefined when it does not parse (nobody to keep in place). */
function resolvedPorts(raw: RawConfig): Map<string, number> | undefined {
  try {
    return new Map(parseConfig(raw).people.map((x) => [x.name, x.port]));
  } catch {
    return undefined;
  }
}

const APPLY_FLAGS = ["--yes", "--i-understand-this-changes-the-host"];
const hasApplyFlags = (p: Parsed) => APPLY_FLAGS.every((f) => p.bools.has(f));
const REFUSAL = "refusing: apply changes the host. Pass --yes and --i-understand-this-changes-the-host after reading apply.sh.\n";

/**
 * What state a failed apply leaves and what to do next. apply has no resume: a second run stops at the first step that
 * cannot be repeated (useradd, or for a migration the old-home guard). So it names the failed step, the steps after it,
 * and, once a migration has moved the old PASEO_HOME, that the data is already in the new account.
 */
function failureState(plan: Plan, out: string, failedId: string | undefined, executed: string[], only?: (id: string) => boolean): string {
  const failed = plan.steps.find((s) => s.id === failedId);
  const at = plan.steps.findIndex((s) => s.id === failedId);
  const later = at < 0 ? [] : plan.steps.slice(at + 1).filter((s) => (!only || only(s.id)) && s.kind !== "manual").map((s) => s.id);
  const lines: string[] = [];
  if (failed) lines.push(`Failed step: ${failed.description}\n`);
  const moved = executed.find((id) => id.endsWith(".move-paseo-home"));
  if (moved) {
    lines.push(
      `The old PASEO_HOME was already moved (${moved} ran) and the shared daemon is stopped. apply is not resumable: running migrate again stops at the ` +
        `old-home guard, because that person is already migrated. Fix the cause, then run the steps below by hand, in this order, from ${join(out, "apply.sh")}.\n`,
    );
  } else {
    lines.push(`apply is not resumable: a second run stops at the first step that cannot be repeated. Steps after it are listed below; they are in ${join(out, "apply.sh")}.\n`);
  }
  if (later.length > 0) lines.push(`Not run: ${later.join(", ")}\n`);
  return lines.join("");
}

async function runApply(plan: Plan, out: string, io: CliIo, only?: (id: string) => boolean): Promise<number> {
  const isRoot = (io.isRoot ?? (() => process.getuid?.() === 0))();
  const privileged = plan.steps.filter((s) => s.privileged && stepArgv(s) && (!only || only(s.id)));
  if (isRoot) {
    io.stderr("running as root: only privileged steps will run; run again as your normal user for the rest.\n");
  } else if (privileged.length > 0) {
    io.stderr(`${privileged.length} privileged step(s) need root and will NOT run now; run apply again as root for them.\n`);
  }
  const result = await applyPlan(plan, out, io.runner ?? spawnRunner, { isRoot, ...(only ? { only } : {}) });
  for (const id of result.executed) io.stdout(`ok     ${id}\n`);
  for (const s of result.skipped) io.stdout(`skip   ${s.id} (${s.reason})\n`);
  if (!result.ok) {
    io.stderr(`FAILED at ${result.failed?.id} (exit ${result.failed?.code}); later steps did not run.\n`);
    io.stderr(failureState(plan, out, result.failed?.id, result.executed, only));
    return 1;
  }
  return 0;
}

function requirePerson(config: ResolvedConfig, name: string | undefined): string {
  if (!name) throw new UsageError("person name required");
  if (!config.people.some((p) => p.name === name)) {
    throw new UsageError(`unknown person "${name}" (known: ${config.people.map((p) => p.name).join(", ")})`);
  }
  return name;
}

const isSameUser = (p: { isolation?: string | undefined }) => (p.isolation ?? "same-user") === "same-user";

// ---------------------------------------------------------------- commands that only edit the stored config

async function cmdInit(args: string[], io: CliIo): Promise<number> {
  const p = parseFlags(args, ["--from", "--listen", "--port", "--existing", "--paseo-binary", "--path", "--config"], ["--web-ui", "--force"], ["--existing"]);
  if (p.positional.length > 0) throw new UsageError(`unexpected argument ${p.positional[0]}`);
  const store = storeFor(io, p);
  const exists = await stat(store.file).then(() => true, () => false);
  if (exists && !p.bools.has("--force")) {
    throw new UsageError(`${store.file} already exists: not overwriting. Pass --force to replace it.`);
  }

  const from = p.value("--from");
  let raw: RawConfig;
  if (from) {
    const others = ["--listen", "--port", "--existing", "--paseo-binary", "--path"].filter((f) => p.values.has(f));
    if (others.length > 0 || p.bools.has("--web-ui")) throw new UsageError("--from adopts a config as it is: do not combine it with other config flags");
    raw = await loadFile(from);
    parseConfig(raw); // throws ConfigError with every problem; nothing is written
  } else {
    const detected: Detected = await (io.detector ?? (async () => ({})))();
    const listenAddress = p.value("--listen") ?? detected.listenAddress;
    if (!listenAddress) throw new UsageError("--listen <address> is required: nothing here can tell which address the daemons should listen on");
    const userHome = detected.userHome;
    if (!userHome) throw new UsageError("cannot tell your home directory: set HOME");
    const paseoBinary = p.value("--paseo-binary") ?? detected.paseoBinary;
    if (!paseoBinary) throw new UsageError("paseo was not found on PATH: pass --paseo-binary <absolute path>");
    const portText = p.value("--port");
    const basePort = portText === undefined ? 7100 : Number(portText);
    if (!Number.isInteger(basePort)) throw new UsageError("--port must be a whole number");
    const environmentPath = p.value("--path") ?? detected.environmentPath;
    const existingDaemons = (p.values.get("--existing") ?? []).map((e) => {
      const m = /^([^:\s]+):(\d+)$/.exec(e);
      if (!m) throw new UsageError(`--existing expects <name>:<port>, got "${e}"`);
      return { name: m[1] as string, port: Number(m[2]) };
    });
    raw = {
      userHome,
      listenAddress,
      basePort,
      paseoBinary,
      ...(environmentPath ? { environmentPath } : {}),
      ...(p.bools.has("--web-ui") ? { webUi: true } : {}),
      ...(existingDaemons.length ? { existingDaemons } : {}),
      people: [],
    };
    // Validate everything but the people list, which `add` fills in (a config needs at least one person to parse).
    parseConfig({ ...raw, people: [{ name: "placeholder", acknowledge: ["shared-provider-history"] }] });
  }
  // Read the config being replaced, if it can be read, so that a name reused by a different person (or dropped) does not
  // leave the previous person's staged password behind to be picked up by the next render.
  const replaced = exists ? replacedNames(await readRawConfig(store.file).catch(() => ({ people: [] }) as unknown as RawConfig), raw) : [];
  await writeRawConfig(store.file, raw, store.ownDir);
  const forgotten = replaced.length > 0 && (await forgetStagedSecrets(io, store, replaced)) === "deleted";
  io.stdout(`Wrote ${store.file} (mode 0600). The host was not changed.\n`);
  if (forgotten) {
    io.stdout(`Deleted the staged passwords of ${replaced.join(", ")} from the default render directory: they are gone or are a different person now, so they get new passwords. If you rendered into another --out directory, delete secrets/<name>.* there.\n`);
  }
  io.stdout(from ? "Adopted as it is. Next: paseo-users plan\n" : "Next: paseo-users add <name> --shared\n");
  return 0;
}

/**
 * Ports without an explicit value are assigned on every parse, in order, around the explicit ones. Adding a person with
 * an explicit port that an earlier person is auto-assigned would silently move that person (and their unit and health
 * check) while their daemon still holds the old port. Refused before anything is written.
 */
function refuseMovedPorts(before: RawConfig, after: ResolvedConfig, added: string): void {
  const was = resolvedPorts(before);
  if (!was) return;
  const moved = after.people.filter((x) => was.has(x.name) && was.get(x.name) !== x.port);
  if (moved.length > 0) {
    throw new UsageError(
      `adding ${added} would move the port of ${moved.map((x) => `${x.name} (${was.get(x.name)} -> ${x.port})`).join(", ")}, ` +
        "whose daemon may be running there. Choose another --port, or give them an explicit port in the config first.",
    );
  }
}

const SEPARATE_ONLY_FLAGS = ["--unix-account", "--providers", "--paseo-version"];

async function cmdAdd(args: string[], io: CliIo): Promise<number> {
  const p = parseFlags(args, ["--port", "--config", ...SEPARATE_ONLY_FLAGS], ["--shared", "--separate", "--acknowledge-shared-history"]);
  const name = p.positional[0];
  const usage = "usage: add <name> --shared [--port <n>] [--acknowledge-shared-history]\n   or: add <name> --separate --unix-account <acct> --providers <id,id,...> [--paseo-version <x.y.z>] [--port <n>]";
  if (!name || p.positional.length > 1) throw new UsageError(usage);
  const shared = p.bools.has("--shared");
  const separate = p.bools.has("--separate");
  if (shared && separate) throw new UsageError("--shared and --separate exclude each other: choose one");
  if (!shared && !separate) {
    throw new UsageError("choose how this person runs: --shared (same Linux user) or --separate (own account and own installs)");
  }
  if (!separate) {
    // Fail closed: a flag that only means something for a separate person is refused, never silently ignored.
    for (const f of SEPARATE_ONLY_FLAGS) if (p.values.has(f)) throw new UsageError(`${f} is only valid with --separate`);
  } else if (p.bools.has("--acknowledge-shared-history")) {
    throw new UsageError("--acknowledge-shared-history is only valid with --shared");
  }
  const store = storeFor(io, p);
  const raw = await readRawConfig(store.file);
  const portText = p.value("--port");
  const port = portText === undefined ? undefined : Number(portText);
  if (port !== undefined && !Number.isInteger(port)) throw new UsageError("--port must be a whole number");

  if (separate) return addSeparate(p, name, port, store, raw, io);

  const ack = p.bools.has("--acknowledge-shared-history");
  let people = [...(raw.people ?? [])];
  const widened: string[] = [];
  if (ack) {
    // The operator accepts the trade-off for the whole shared set: people who gain a neighbour now are covered too.
    people = people.map((x) => {
      if (!isSameUser(x) || (x.acknowledge ?? []).includes("shared-provider-history")) return x;
      widened.push(x.name);
      return { ...x, acknowledge: [...(x.acknowledge ?? []), "shared-provider-history"] };
    });
  }
  people.push({ name, ...(port !== undefined ? { port } : {}), ...(ack ? { acknowledge: ["shared-provider-history"] } : {}) });
  const next: RawConfig = { ...raw, people };
  const resolved = parseConfig(next); // refuses (ConfigError) before anything is written
  refuseMovedPorts(raw, resolved, name);
  await writeRawConfig(store.file, next, store.ownDir);
  await forgetStagedSecrets(io, store, [name]);
  const added = resolved.people.find((x) => x.name === name);
  io.stdout(`Added ${name} (shared, same Linux user) on port ${added?.port}. The host was not changed.\n`);
  if (widened.length) io.stdout(`Also recorded the shared-history acknowledgement for: ${widened.join(", ")}\n`);
  io.stdout(`Next: paseo-users plan ${name}   then   paseo-users render   then read apply.sh and run: paseo-users apply ${name} --yes --i-understand-this-changes-the-host\n`);
  return 0;
}

/**
 * `add <name> --separate`: own unix account, own installs. Every value is explicit (no default account, no default
 * version). The result is validated by parseConfig before anything is written. UNVERIFIED on a real host.
 */
async function addSeparate(p: Parsed, name: string, port: number | undefined, store: Store, raw: RawConfig, io: CliIo): Promise<number> {
  const unixAccount = p.value("--unix-account");
  if (unixAccount === undefined) throw new UsageError("--separate needs --unix-account <acct>: there is no default account name");
  const providersText = p.value("--providers");
  if (providersText === undefined) throw new UsageError("--separate needs --providers <id,id,...> (known: claude, codex, opencode)");
  // Split on "," only: no trimming and no case folding, so what is stored is what was typed. Validation names bad entries.
  const providers = providersText.split(",");
  if (providers.some((x) => x === "")) {
    throw new UsageError(`--providers needs a comma-separated list of provider ids without empty entries, got "${providersText}"`);
  }

  const stored = raw.paseoVersion;
  const given = p.value("--paseo-version");
  if (stored !== undefined && given !== undefined && given !== stored) {
    throw new UsageError(`--paseo-version ${given} differs from the stored paseoVersion ${stored}: every separate person uses one pinned version`);
  }
  const paseoVersion = given ?? stored;
  if (paseoVersion === undefined) {
    throw new UsageError("--separate needs --paseo-version <x.y.z> (exact, no range or tag): none is stored yet");
  }

  const person = { name, isolation: "unix-account", unixAccount, install: "separate" as const, providers, ...(port !== undefined ? { port } : {}) };
  const next: RawConfig = { ...raw, paseoVersion, people: [...(raw.people ?? []), person] };
  const resolved = parseConfig(next); // refuses (ConfigError) before anything is written: exact version, known providers, account rules
  refuseMovedPorts(raw, resolved, name);
  await writeRawConfig(store.file, next, store.ownDir);
  await forgetStagedSecrets(io, store, [name]);
  const added = resolved.people.find((x) => x.name === name);
  io.stdout(
    `Added ${name} (separate: own computer account, own installs of paseo ${paseoVersion} and ${providers.join(", ")}) on port ${added?.port}. The host was not changed.\n`,
  );
  io.stdout(`${name} must log in to each provider (${providers.join(", ")}) by hand, in a shell as their own account. The plan cannot do it and copies no login. UNVERIFIED on a real host.\n`);
  io.stdout(`Next: paseo-users plan ${name}   then   paseo-users render   then read apply.sh and run: paseo-users apply ${name} --yes --i-understand-this-changes-the-host\n`);
  return 0;
}

async function cmdRemove(args: string[], io: CliIo): Promise<number> {
  const p = parseFlags(args, ["--config"], []);
  const name = p.positional[0];
  if (!name || p.positional.length > 1) throw new UsageError("usage: remove <name>");
  const store = storeFor(io, p);
  const raw = await readRawConfig(store.file);
  const people = raw.people ?? [];
  if (!people.some((x) => x.name === name)) {
    throw new UsageError(`unknown person "${name}" (known: ${people.map((x) => x.name).join(", ") || "none"})`);
  }
  const remaining = people.filter((x) => x.name !== name);
  const { paseoVersion: _version, ...rest } = raw;
  // paseoVersion is only valid while someone is separate; drop it with the last separate person so remove stays possible.
  const next: RawConfig = remaining.some((x) => x.install === "separate") ? { ...raw, people: remaining } : { ...rest, people: remaining };
  // Everyone left keeps the port they have now: an auto-assigned port is written down when removing someone would shift it.
  const pinned: string[] = [];
  if (next.people.length > 0) {
    const was = resolvedPorts(raw);
    const nowPorts = parseConfig(next).people;
    if (was) {
      next.people = next.people.map((x) => {
        const before = was.get(x.name);
        if (x.port !== undefined || before === undefined || nowPorts.find((r) => r.name === x.name)?.port === before) return x;
        pinned.push(`${x.name} ${before}`);
        return { ...x, port: before };
      });
      if (pinned.length > 0) parseConfig(next);
    }
  }
  await writeRawConfig(store.file, next, store.ownDir);
  const forgot = await forgetStagedSecrets(io, store, [name]);
  io.stdout(`Removed ${name} from the config. The host is NOT changed: their daemon, files and password still exist.\n`);
  if (pinned.length > 0) io.stdout(`Kept the port of everyone else where it was (written into the config): ${pinned.join(", ")}.\n`);
  io.stdout(
    forgot === "deleted"
      ? `The staged password files for ${name} in the default render directory were deleted, so a new ${name} gets a new password. If you rendered into another --out directory, delete secrets/${name}.* there.\n`
      : forgot === "other-config"
        ? `This is not the default config, so the default render directory was left alone. Delete secrets/${name}.* in any directory you rendered ${name} into, so a new ${name} gets a new password.\n`
        : `The default render directory could not be located: delete secrets/${name}.* in any directory you rendered into, so a new ${name} gets a new password.\n`,
  );
  io.stdout(`If they were ever applied, run "paseo-users revoke ${name}" BEFORE removing them (the plan needs the config entry).\n`);
  return 0;
}

const KNOWN_STATES = new Set(["active", "inactive", "failed", "activating", "deactivating", "reloading"]);

async function cmdList(args: string[], io: CliIo): Promise<number> {
  const p = parseFlags(args, ["--config"], ["--json"]);
  const store = storeFor(io, p);
  const raw = await readRawConfig(store.file);
  const rows: { name: string; isolation: string; mode: string; port: number; state: string }[] = [];
  if ((raw.people ?? []).length > 0) {
    const config = parseConfig(raw);
    for (const person of config.people) {
      let state = "unknown";
      // Only a same-user daemon lives in this user's systemd manager; another account's is not visible from here.
      if (person.isolation === "same-user" && io.query) {
        try {
          const r = await io.query.query(["systemctl", "--user", "is-active", `paseo-${person.name}.service`]);
          const text = r.stdout.trim();
          if (KNOWN_STATES.has(text)) state = text;
        } catch {
          state = "unknown";
        }
      }
      rows.push({ name: person.name, isolation: person.isolation, mode: person.install === "separate" ? "separate" : person.isolation === "same-user" ? "shared" : person.isolation, port: person.port, state });
    }
  }
  if (p.bools.has("--json")) {
    io.stdout(`${JSON.stringify(rows, null, 2)}\n`);
    return 0;
  }
  if (rows.length === 0) {
    io.stdout('No people yet. Add one with: paseo-users add <name> --shared\n');
    return 0;
  }
  io.stdout(["NAME", "MODE", "PORT", "STATE"].join("\t") + "\n");
  for (const r of rows) io.stdout([r.name, r.mode, String(r.port), r.state].join("\t") + "\n");
  return 0;
}

// ---------------------------------------------------------------- plan / render / revoke / apply / password

async function cmdPlan(args: string[], io: CliIo): Promise<number> {
  const p = parseFlags(args, ["--config"], ["--json"]);
  const [a, b] = p.positional;
  let config: ResolvedConfig;
  let name: string | undefined;
  if (isConfigArg(a)) {
    config = parseConfig(await loadFile(a));
    name = b;
  } else {
    config = await loadStored(storeFor(io, p));
    name = a;
  }
  let plan = planHost(config);
  if (name) plan = planForPerson(plan, requirePerson(config, name));
  io.stdout(p.bools.has("--json") ? `${JSON.stringify(plan, null, 2)}\n` : summary(plan));
  return 0;
}

async function cmdRender(args: string[], io: CliIo): Promise<number> {
  const p = parseFlags(args, ["--out", "--rotate", "--config"], []);
  const [a] = p.positional;
  const legacy = isConfigArg(a);
  let config: ResolvedConfig;
  let out: string;
  if (legacy) {
    const given = p.value("--out");
    if (!given) throw new UsageError("--out <dir> required");
    out = given;
    config = parseConfig(await loadFile(a));
  } else {
    if (a !== undefined) throw new UsageError(`unexpected argument ${a}`);
    config = await loadStored(storeFor(io, p));
    out = await outDirFor(io, p, "render");
  }
  const rotate = p.value("--rotate");
  const r = await renderHost(planHost(config), out, rotate ? { rotate: rotate === "all" ? "all" : [rotate] } : {});
  io.stdout(renderSummary(r));
  return 0;
}

async function cmdRevokePlan(args: string[], io: CliIo): Promise<number> {
  const p = parseFlags(args, ["--out", "--config"], ["--json"]);
  const [a, b] = p.positional;
  let config: ResolvedConfig;
  let name: string | undefined;
  if (isConfigArg(a)) {
    config = parseConfig(await loadFile(a));
    name = b;
  } else {
    config = await loadStored(storeFor(io, p));
    name = a;
  }
  if (!name) throw new UsageError("person name required");
  const plan = planRevoke(config, requirePerson(config, name));
  io.stdout(p.bools.has("--json") ? `${JSON.stringify(plan, null, 2)}\n` : summary(plan));
  const out = p.value("--out");
  if (out) {
    const r = await renderPlan(plan, out);
    io.stdout(`Rendered to ${r.outDir} with a rotated password for ${name}. Use a directory separate from the host plan.\n`);
  }
  return 0;
}

async function cmdApply(args: string[], io: CliIo): Promise<number> {
  const p = parseFlags(args, ["--out", "--config"], APPLY_FLAGS);
  // A trailing name is never ignored: `plan <config> <name>` is scoped, so `apply <config> <name>` must not widen to the
  // whole host plan, and the stored-config form takes exactly one name.
  if (p.positional.length > 1) {
    throw new UsageError(
      isConfigArg(p.positional[0])
        ? `apply <config.json> applies the whole plan and takes no person name (got "${p.positional[1]}"). To apply one person, store the config and run: paseo-users apply ${p.positional[1]}`
        : `apply takes one person name, got ${p.positional.length}: ${p.positional.join(" ")}`,
    );
  }
  if (!hasApplyFlags(p)) {
    io.stderr(REFUSAL);
    return 2;
  }
  const [a] = p.positional;
  if (isConfigArg(a)) {
    // Older form: the whole plan, into an explicit --out.
    const out = p.value("--out");
    if (!out) throw new UsageError("--out <dir> required");
    return runApply(planHost(parseConfig(await loadFile(a))), out, io);
  }
  const config = await loadStored(storeFor(io, p));
  const name = requirePerson(config, a);
  const plan = planHost(config);
  const out = await outDirFor(io, p, "render");
  const rendered = await readFile(join(out, "plan.json"), "utf8").catch(() => undefined);
  let current = false;
  try {
    current = rendered !== undefined && JSON.stringify(JSON.parse(rendered)) === JSON.stringify(plan);
  } catch {
    current = false;
  }
  if (!current) {
    // Never apply something that was not rendered and reviewed: render now, then stop so you can read it.
    const r = await renderHost(plan, out);
    io.stdout(renderSummary(r));
    io.stderr(`refusing: ${rendered === undefined ? "nothing was rendered yet" : "the rendered plan was out of date"}. It is rendered now. Read ${r.outDir}/apply.sh, then run this command again.\n`);
    return 2;
  }
  return runApply(plan, out, io, personStepFilter(plan, name));
}

async function cmdRevoke(args: string[], io: CliIo): Promise<number> {
  const p = parseFlags(args, ["--out", "--config"], ["--apply", ...APPLY_FLAGS]);
  const wantApply = p.bools.has("--apply");
  if (wantApply && !hasApplyFlags(p)) {
    io.stderr(REFUSAL);
    return 2;
  }
  if (p.positional.length > 1) throw new UsageError("usage: revoke <name> [--apply ...]");
  const config = await loadStored(storeFor(io, p));
  const name = requirePerson(config, p.positional[0]);
  const plan = planRevoke(config, name);
  const out = await outDirFor(io, p, `revoke-${name}`);
  io.stdout(summary(plan));
  const r = await renderPlan(plan, out);
  io.stdout(`Rendered to ${r.outDir} with a rotated password for ${name}. Read apply.sh there.\n`);
  if (!wantApply) {
    io.stdout(`Nothing was applied. To apply: paseo-users revoke ${name} --apply --yes --i-understand-this-changes-the-host\n`);
    return 0;
  }
  return runApply(plan, out, io);
}

async function cmdMigrate(args: string[], io: CliIo): Promise<number> {
  const p = parseFlags(args, ["--out", "--config"], ["--apply", ...APPLY_FLAGS]);
  const wantApply = p.bools.has("--apply");
  if (wantApply && !hasApplyFlags(p)) {
    io.stderr(REFUSAL);
    return 2;
  }
  if (p.positional.length > 1) throw new UsageError("usage: migrate <name> [--out <dir>] [--apply --yes --i-understand-this-changes-the-host]");
  const config = await loadStored(storeFor(io, p));
  const name = requirePerson(config, p.positional[0]);
  // Refuses (exit 2) unless the stored config already describes this person as separate. Nothing is rendered before that.
  const plan = planMigrate(config, name);
  const person = config.people.find((x) => x.name === name);
  if (person) {
    const old = sharedLayout(person, config);
    await refuseOutInside(p.value("--out") ?? join(stateDir(io.env ?? {}), `migrate-${name}`), [old.home, old.envFile]);
  }
  const out = await outDirFor(io, p, `migrate-${name}`);
  io.stdout(summary(plan));
  // renderPlan, not renderHost: the plan has no secret to stage (the existing password is carried by a copy step), so no
  // password is generated and no secrets/ directory is written.
  const r = await renderPlan(plan, out);
  io.stdout(`Rendered to ${r.outDir}. No password was generated; the existing one is copied across. Read apply.sh there.\n`);
  if (!wantApply) {
    io.stdout(`Nothing was applied: the host was not changed. To apply: paseo-users migrate ${name} --apply --yes --i-understand-this-changes-the-host\n`);
    io.stdout("Run it twice: once as your normal user (stops the shared daemon), then as root (the first root step refuses while the old daemon may still run).\n");
    return 0;
  }
  return runApply(plan, out, io);
}

async function cmdPassword(args: string[], io: CliIo): Promise<number> {
  const p = parseFlags(args, ["--out", "--config"], ["--stdin"]);
  if (p.positional.length > 1) throw new UsageError("usage: password <name> [--stdin]  (the passphrase is read from stdin, never from the command line)");
  const config = await loadStored(storeFor(io, p));
  const name = requirePerson(config, p.positional[0]);
  const plan = planHost(config);
  const out = await outDirFor(io, p, "render");
  let opts: RenderOptions;
  if (p.bools.has("--stdin")) {
    const line = await (io.readLine ?? (async () => undefined))();
    if (line === undefined) throw new UsageError("no passphrase on stdin: pipe one line in");
    const passphrase = line.replace(/\r$/, "");
    const problem = passphraseProblem(passphrase, name);
    if (problem) throw new UsageError(problem);
    opts = { passwords: { [name]: passphrase } };
  } else {
    opts = { rotate: [name] };
  }
  const r = await renderHost(plan, out, opts);
  const person = plan.people.find((x) => x.name === name);
  const step = plan.steps.find((s) => s.id === `${name}.secret-env`);
  const argv = step ? stepArgv(step) : undefined;
  io.stdout(`${p.bools.has("--stdin") ? "Set the chosen passphrase" : "Generated a new random password"} for ${name} in ${r.outDir}/secrets/ (the host was NOT changed; the passphrase is not shown).\n`);
  io.stdout("The running daemon keeps the old password until you do these two steps:\n");
  if (argv) {
    io.stdout(`  1. ${step?.privileged ? "as root" : "as your normal user"}: cd ${shellQuote(r.outDir)} && ${argv.map(shellQuote).join(" ")}\n`);
    // Only a same-user person's steps can be run again. A unix-account plan starts with useradd, which stops once the
    // account exists, so a full apply would fail there before reaching this step.
    io.stdout(
      person?.isolation === "same-user"
        ? `     (or: paseo-users apply ${name} --yes --i-understand-this-changes-the-host, which also re-runs ${name}'s other steps)\n`
        : `     (do not re-run apply for ${name}: it stops at the account creation, which cannot be repeated)\n`,
    );
  }
  io.stdout(
    person?.isolation === "same-user"
      ? `  2. restart the daemon so it reads the new password: systemctl --user restart paseo-${name}.service\n`
      : `  2. restart ${name}'s daemon in their account's systemd user manager (see docs/11-daemon-per-person-runbook.md)\n`,
  );
  io.stdout(`Read ${r.outDir}/apply.sh first; it was rendered again.\n`);
  return 0;
}

export async function main(argv: string[], io: CliIo): Promise<number> {
  const [cmd, ...rest] = argv;
  try {
    switch (cmd) {
      case "init":
        return await cmdInit(rest, io);
      case "add":
        return await cmdAdd(rest, io);
      case "remove":
        return await cmdRemove(rest, io);
      case "list":
        return await cmdList(rest, io);
      case "plan":
        return await cmdPlan(rest, io);
      case "render":
        return await cmdRender(rest, io);
      case "revoke-plan":
        return await cmdRevokePlan(rest, io);
      case "apply":
        return await cmdApply(rest, io);
      case "revoke":
        return await cmdRevoke(rest, io);
      case "migrate":
        return await cmdMigrate(rest, io);
      case "password":
        return await cmdPassword(rest, io);
      case "--version":
        io.stdout(`${io.version ?? "unknown"}\n`);
        return 0;
      case "help":
      case "--help":
        io.stdout(USAGE);
        return 0;
      default:
        io.stderr(USAGE);
        return cmd === undefined ? 0 : 2;
    }
  } catch (e) {
    if (e instanceof Error) {
      io.stderr(`${e.message}\n`);
      // Refusals, validation and usage problems are 2. A file-system or process failure is a runtime failure.
      const runtime = !(e instanceof UsageError || e instanceof ConfigError || e instanceof ApplyRefused) && typeof (e as NodeJS.ErrnoException).code === "string";
      return runtime ? 1 : 2;
    }
    throw e;
  }
}
