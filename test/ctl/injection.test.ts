import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const CTL = join(__dirname, "../../tools/ctl");

async function sources(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await sources(p)));
    else if (e.name.endsWith(".ts")) out.push(p);
  }
  return out;
}

describe("injection", () => {
  it("only the wiring file (bin.ts) reads process.env or the real home", async () => {
    const offenders: string[] = [];
    for (const f of await sources(CTL)) {
      if (f.endsWith("/bin.ts")) continue;
      const text = await readFile(f, "utf8");
      if (/process\.env|homedir|process\.stdin/.test(text)) offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });

  it("bin.ts has the shebang, and reads the environment only inside wire()", async () => {
    const text = await readFile(join(CTL, "bin.ts"), "utf8");
    expect(text.startsWith("#!/usr/bin/env node\n")).toBe(true);
    const start = text.indexOf("async function wire");
    const end = text.indexOf("process.exitCode");
    expect(start).toBeGreaterThan(-1);
    const outside = text.slice(0, start) + text.slice(end);
    expect(outside).not.toMatch(/process\.env|homedir\(/);
    expect(text.slice(start, end)).toMatch(/process\.env/);
  });
});
