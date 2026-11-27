import { delimiter, isAbsolute, join } from "node:path";
import type { HostEnv } from "./store.js";

/** What `init` may fill in by itself. Every field is optional; a missing one is asked for, never guessed. */
export interface Detected {
  paseoBinary?: string;
  environmentPath?: string;
  userHome?: string;
  listenAddress?: string;
}

/** Must only READ, and must never read credentials. */
export type Detector = () => Promise<Detected>;

export interface DetectorDeps {
  env: HostEnv;
  /** Reads a text file; rejects when absent. Only ever called with `unitPath`. */
  readFile(path: string): Promise<string>;
  /** Resolves when the path is an executable file. */
  isExecutable(path: string): Promise<boolean>;
  /** A systemd user unit to copy `Environment=PATH=` from. Skipped when absent. */
  unitPath?: string;
}

/** `Environment=PATH=...` from a unit file's text, or undefined. Takes the last one, like systemd. */
export function parseUnitPath(text: string): string | undefined {
  let found: string | undefined;
  for (const line of text.split("\n")) {
    const m = /^\s*Environment=(?:"PATH=([^"]*)"|PATH=(\S+))\s*$/.exec(line);
    if (m) found = m[1] ?? m[2];
  }
  return found;
}

export function createDetector(deps: DetectorDeps): Detector {
  return async () => {
    const out: Detected = {};
    if (deps.env.home && isAbsolute(deps.env.home)) out.userHome = deps.env.home;
    for (const dir of (deps.env.path ?? "").split(delimiter)) {
      if (!dir || !isAbsolute(dir)) continue;
      const candidate = join(dir, "paseo");
      if (await deps.isExecutable(candidate).catch(() => false)) {
        out.paseoBinary = candidate;
        break;
      }
    }
    if (deps.unitPath) {
      const text = await deps.readFile(deps.unitPath).catch(() => undefined);
      const p = text === undefined ? undefined : parseUnitPath(text);
      if (p) out.environmentPath = p;
    }
    return out;
  };
}
