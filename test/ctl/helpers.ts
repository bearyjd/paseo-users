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

/** Raw config as written, no acknowledgements added. Use this to test the acknowledgement rule. */
export const rawCfg = (extra: Record<string, unknown> = {}) => ({
  ...BASE,
  people: [{ name: "ann" }, { name: "bob" }],
  ...extra,
});

/**
 * Like rawCfg, but every same-user person without an `acknowledge` key gets the shared-history acknowledgement, so
 * tests about other things need not repeat it.
 */
export const cfg = (extra: Record<string, unknown> = {}) => {
  const raw = rawCfg(extra);
  return {
    ...raw,
    people: (raw.people as Record<string, unknown>[]).map((p) =>
      p.acknowledge === undefined && (p.isolation === undefined || p.isolation === "same-user")
        ? { ...p, acknowledge: ["shared-provider-history"] }
        : p,
    ),
  };
};

export const tmp = () => mkdtemp(join(tmpdir(), "ctl-"));

export class FakeRunner implements CommandRunner {
  calls: string[][] = [];
  constructor(private failOn?: (argv: string[]) => boolean) {}
  async run(argv: string[]) {
    this.calls.push(argv);
    return { code: this.failOn?.(argv) ? 1 : 0 };
  }
}
