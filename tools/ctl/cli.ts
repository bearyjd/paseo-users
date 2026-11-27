import { execFile, spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { applyPlan, ApplyRefused, type CommandRunner } from "./apply.js";
import { ConfigError, parseConfig, PERSON_NAME, type RawConfig, type ResolvedConfig } from "./config.js";
import type { Detected, Detector } from "./detect.js";
import { writeNotices } from "./notice.js";
import { passphraseProblem } from "./passphrase.js";
import { planForPerson, planHost, planRevoke, stepBelongsTo, type Plan } from "./plan.js";
import { renderPlan, type RenderOptions, type RenderResult } from "./render.js";
import { shellQuote, stepArgv } from "./shell.js";
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
  add <name> --separate        not implemented yet, see docs/12-separate-installs-plan.md
  remove <name>
  list [--json]                people, mode, port and whether the daemon is running (read-only)

Plan and render (the stored config is used; pass --config <file> to use another):
  plan [<name>] [--json]
  render [--out <dir>] [--rotate <name>|all]       default dir: $XDG_STATE_HOME/paseo-users/render
  revoke-plan <name> [--out <dir>] [--json]
  password <name> [--stdin] [--out <dir>]          rotate (random) or set (one line on stdin) a password in the rendered files
  revoke <name> [--out <dir>] [--apply --yes --i-understand-this-changes-the-host]

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

function parseFlags(args: string[], valueFlags: string[], boolFlags: string[]): Parsed {
  const positional: string[] = [];
  const values = new Map<string, string[]>();
  const bools = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (valueFlags.includes(a)) {
      const v = args[++i];
      if (v === undefined) throw new UsageError(`${a} needs a value`);
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
    out.push(`  ${p.name}  ${p.isolation}  port ${p.port}  PASEO_HOME ${p.paseoHome}${p.unixAccount ? `  account ${p.unixAccount}` : ""}`);
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

const APPLY_FLAGS = ["--yes", "--i-understand-this-changes-the-host"];
const hasApplyFlags = (p: Parsed) => APPLY_FLAGS.every((f) => p.bools.has(f));
const REFUSAL = "refusing: apply changes the host. Pass --yes and --i-understand-this-changes-the-host after reading apply.sh.\n";

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
  const p = parseFlags(args, ["--from", "--listen", "--port", "--existing", "--paseo-binary", "--path", "--config"], ["--web-ui", "--force"]);
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
  await writeRawConfig(store.file, raw, store.ownDir);
  io.stdout(`Wrote ${store.file} (mode 0600). The host was not changed.\n`);
  io.stdout(from ? "Adopted as it is. Next: paseo-users plan\n" : "Next: paseo-users add <name> --shared\n");
  return 0;
}

async function cmdAdd(args: string[], io: CliIo): Promise<number> {
  const p = parseFlags(args, ["--port", "--config"], ["--shared", "--separate", "--acknowledge-shared-history"]);
  const name = p.positional[0];
  if (!name || p.positional.length > 1) throw new UsageError("usage: add <name> --shared [--port <n>] [--acknowledge-shared-history]");
  if (p.bools.has("--separate")) {
    io.stderr("--separate is not implemented yet, see docs/12-separate-installs-plan.md\n");
    return 2;
  }
  if (!p.bools.has("--shared")) throw new UsageError("choose how this person runs: --shared (same Linux user). --separate is not implemented yet.");
  const store = storeFor(io, p);
  const raw = await readRawConfig(store.file);
  const portText = p.value("--port");
  const port = portText === undefined ? undefined : Number(portText);
  if (port !== undefined && !Number.isInteger(port)) throw new UsageError("--port must be a whole number");
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
  await writeRawConfig(store.file, next, store.ownDir);
  const added = resolved.people.find((x) => x.name === name);
  io.stdout(`Added ${name} (shared, same Linux user) on port ${added?.port}. The host was not changed.\n`);
  if (widened.length) io.stdout(`Also recorded the shared-history acknowledgement for: ${widened.join(", ")}\n`);
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
  if (next.people.length > 0) parseConfig(next);
  await writeRawConfig(store.file, next, store.ownDir);
  io.stdout(`Removed ${name} from the config. The host is NOT changed: their daemon, files and password still exist.\n`);
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
      rows.push({ name: person.name, isolation: person.isolation, mode: person.isolation === "same-user" ? "shared" : person.isolation, port: person.port, state });
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
  return runApply(plan, out, io, (id) => stepBelongsTo(id, name));
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
    io.stdout(`     (or: paseo-users apply ${name} --yes --i-understand-this-changes-the-host, which also re-runs ${name}'s other steps)\n`);
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
