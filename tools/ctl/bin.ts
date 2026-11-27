#!/usr/bin/env node
import { access, constants, readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { main, spawnQuery, type CliIo } from "./cli.js";
import { createDetector } from "./detect.js";

/** The only place that reads the process environment, the real home, stdin or package.json. Everything else is injected. */
async function wire(): Promise<CliIo> {
  const e = process.env;
  const home = e.HOME ?? homedir();
  const env = {
    home,
    ...(e.XDG_CONFIG_HOME ? { xdgConfigHome: e.XDG_CONFIG_HOME } : {}),
    ...(e.XDG_STATE_HOME ? { xdgStateHome: e.XDG_STATE_HOME } : {}),
    ...(e.PATH ? { path: e.PATH } : {}),
  };
  // package.json is two levels up from the source file and three from the compiled one (dist/tools/ctl).
  const here = dirname(fileURLToPath(import.meta.url));
  let version = "unknown";
  for (const rel of ["../../package.json", "../../../package.json"]) {
    const text = await readFile(join(here, rel), "utf8").catch(() => undefined);
    const parsed = text === undefined ? undefined : (JSON.parse(text) as { name?: string; version?: string });
    if (parsed?.name === "paseo-users" && parsed.version) {
      version = parsed.version;
      break;
    }
  }
  return {
    stdout: (t) => process.stdout.write(t),
    stderr: (t) => process.stderr.write(t),
    env,
    query: spawnQuery,
    version,
    // Reads exactly one line. The passphrase never touches argv or the environment.
    readLine: async () => {
      const rl = createInterface({ input: process.stdin, terminal: false });
      const first = await rl[Symbol.asyncIterator]().next();
      rl.close();
      return first.done ? undefined : first.value;
    },
    // Read-only detection. The unit path is a guess at a common name; a missing file is simply skipped.
    detector: createDetector({
      env,
      readFile: (p) => readFile(p, "utf8"),
      isExecutable: (p) => access(p, constants.X_OK).then(() => true),
      unitPath: join(home, ".config", "systemd", "user", "paseo.service"),
    }),
  };
}

process.exitCode = await main(process.argv.slice(2), await wire());
