import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandRunner } from "../../tools/ctl/apply.js";
import type { RawConfig } from "../../tools/ctl/config.js";

/** Synthetic values only. Nothing here names a real person, host or path. */
export const BASE = {
  userHome: "/home/tester",
  listenAddress: "127.0.0.1",
  basePort: 7100,
  paseoBinary: "/opt/paseo/bin/paseo",
} satisfies Partial<RawConfig>;

export const cfg = (extra: Record<string, unknown> = {}) => ({
  ...BASE,
  people: [{ name: "ann" }, { name: "bob" }],
  ...extra,
});

export const tmp = () => mkdtemp(join(tmpdir(), "ctl-"));

export class FakeRunner implements CommandRunner {
  calls: string[][] = [];
  constructor(private failOn?: (argv: string[]) => boolean) {}
  async run(argv: string[]) {
    this.calls.push(argv);
    return { code: this.failOn?.(argv) ? 1 : 0 };
  }
}
