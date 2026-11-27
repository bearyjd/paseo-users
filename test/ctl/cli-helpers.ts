import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CliIo, QueryRunner } from "../../tools/ctl/cli.js";
import type { Detected } from "../../tools/ctl/detect.js";
import type { HostEnv } from "../../tools/ctl/store.js";
import { FakeRunner, tmp } from "./helpers.js";

export class FakeQuery implements QueryRunner {
  calls: string[][] = [];
  constructor(private answer: (argv: string[]) => { code: number; stdout: string } | Error) {}
  async query(argv: string[]) {
    this.calls.push(argv);
    const a = this.answer(argv);
    if (a instanceof Error) throw a;
    return a;
  }
}

export interface Sandbox {
  root: string;
  env: HostEnv;
  configFile: string;
  stateRoot: string;
  runner: FakeRunner;
  run(argv: string[], extra?: Partial<CliIo>): Promise<{ code: number; out: string; err: string }>;
}

/** Everything lives under a temp dir: config, state, fake home. Nothing real is read or written. */
export async function sandbox(opts: { detected?: Detected; stdin?: string[]; query?: QueryRunner } = {}): Promise<Sandbox> {
  const root = await tmp();
  const env: HostEnv = {
    home: join(root, "home"),
    xdgConfigHome: join(root, "xdg-config"),
    xdgStateHome: join(root, "xdg-state"),
    path: "",
  };
  await mkdir(env.home as string, { recursive: true });
  const stdin = [...(opts.stdin ?? [])];
  const runner = new FakeRunner();
  const detected = opts.detected ?? { userHome: "/home/tester", paseoBinary: "/opt/paseo/bin/paseo" };
  return {
    root,
    env,
    configFile: join(env.xdgConfigHome as string, "paseo-users", "config.json"),
    stateRoot: join(env.xdgStateHome as string, "paseo-users"),
    runner,
    async run(argv, extra = {}) {
      const out: string[] = [];
      const err: string[] = [];
      const io: CliIo = {
        stdout: (t) => out.push(t),
        stderr: (t) => err.push(t),
        env,
        runner,
        isRoot: () => false,
        detector: async () => detected,
        readLine: async () => stdin.shift(),
        version: "9.9.9",
        ...(opts.query ? { query: opts.query } : {}),
        ...extra,
      };
      const { main } = await import("../../tools/ctl/cli.js");
      const code = await main(argv, io);
      return { code, out: out.join(""), err: err.join("") };
    },
  };
}

export async function writeJson(path: string, value: unknown): Promise<string> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, JSON.stringify(value));
  return path;
}
