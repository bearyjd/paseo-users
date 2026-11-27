import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { RawConfig } from "./config.js";

/** Raised for usage errors, validation failures and refusals. The CLI exits 2 for these. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

/** The pieces of the process environment the tool needs, resolved once by the wiring code and passed down. */
export interface HostEnv {
  home?: string;
  xdgConfigHome?: string;
  xdgStateHome?: string;
  /** PATH, used only to find the paseo binary. */
  path?: string;
}

const abs = (p: string | undefined) => (p && isAbsolute(p) ? p : undefined);

/** `$XDG_CONFIG_HOME/paseo-users/config.json`, default `~/.config/paseo-users/config.json`. */
export function defaultConfigPath(env: HostEnv): string {
  const base = abs(env.xdgConfigHome) ?? (abs(env.home) ? join(env.home as string, ".config") : undefined);
  if (!base) throw new UsageError("cannot locate the config: set HOME or XDG_CONFIG_HOME, or pass --config <file>");
  return join(base, "paseo-users", "config.json");
}

/** `$XDG_STATE_HOME/paseo-users`, default `~/.local/state/paseo-users`. */
export function stateDir(env: HostEnv): string {
  const base = abs(env.xdgStateHome) ?? (abs(env.home) ? join(env.home as string, ".local", "state") : undefined);
  if (!base) throw new UsageError("cannot locate the state directory: set HOME or XDG_STATE_HOME, or pass --out <dir>");
  return join(base, "paseo-users");
}

/** Create `dir` (and parents) and make sure the leaf is 0700. Only used for directories this tool owns. */
export async function ensurePrivateDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
}

export async function readRawConfig(path: string): Promise<RawConfig> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      throw new UsageError(`no config at ${path}: run "paseo-users init" first (or "init --from <config.json>" to adopt one)`);
    }
    throw e;
  }
  try {
    return JSON.parse(text) as RawConfig;
  } catch {
    throw new UsageError(`${path} is not valid JSON`);
  }
}

/**
 * Write the config atomically. The file is 0600. The directory is 0700 when this tool created it or when it is the
 * default `paseo-users` directory (`ownDir`); a directory the user chose with --config is not chmod-ed if it existed.
 */
export async function writeRawConfig(path: string, raw: RawConfig, ownDir: boolean): Promise<void> {
  const dir = dirname(resolve(path));
  const existed = await stat(dir).then(() => true, () => false);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if (!existed || ownDir) await chmod(dir, 0o700);
  const tmp = `${resolve(path)}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, resolve(path));
}
