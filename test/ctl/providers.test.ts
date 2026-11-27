import { describe, expect, it } from "vitest";
import { PROVIDER_IDS, PROVIDERS, getProvider } from "../../tools/ctl/providers.js";

// The npm package names were checked against the registry on 2026-11-27. Whether installing and logging in
// with them works on a real host is UNVERIFIED.
describe("provider catalog", () => {
  it("lists exactly claude, codex and opencode, in a stable order", () => {
    expect([...PROVIDER_IDS]).toEqual(["claude", "codex", "opencode"]);
    expect(PROVIDERS.map((p) => p.id)).toEqual([...PROVIDER_IDS]);
  });

  it("maps each provider to its npm package and binary", () => {
    expect(PROVIDERS.map((p) => [p.id, p.npmPackage, p.bin])).toEqual([
      ["claude", "@anthropic-ai/claude-code", "claude"],
      ["codex", "@openai/codex", "codex"],
      ["opencode", "opencode-ai", "opencode"],
    ]);
  });

  it("is npm-only: an entry has exactly id, npmPackage, bin and loginHint", () => {
    for (const p of PROVIDERS) expect(Object.keys(p).sort()).toEqual(["bin", "id", "loginHint", "npmPackage"]);
  });

  it("gives every provider a non-empty login hint that names its binary", () => {
    for (const p of PROVIDERS) {
      expect(p.loginHint.trim().length).toBeGreaterThan(0);
      expect(p.loginHint).toContain(p.bin);
    }
  });

  it("has unique ids, packages and binaries, and no value that could be read as shell syntax", () => {
    for (const key of ["id", "npmPackage", "bin"] as const) {
      const values = PROVIDERS.map((p) => p[key]);
      expect(new Set(values).size).toBe(values.length);
    }
    for (const p of PROVIDERS) {
      expect(p.npmPackage).toMatch(/^(@[a-z0-9-]+\/)?[a-z0-9][a-z0-9.-]*$/);
      expect(p.bin).toMatch(/^[a-z][a-z0-9-]*$/);
    }
  });

  it("does not list the paseo CLI as a provider (it is installed from paseoVersion, not providers)", () => {
    expect(PROVIDER_IDS).not.toContain("paseo");
    expect(PROVIDERS.some((p) => p.npmPackage === "@getpaseo/cli")).toBe(false);
  });
});

describe("getProvider", () => {
  it.each([...PROVIDER_IDS])("returns the catalog entry for %s", (id: string) => {
    expect(getProvider(id)).toEqual(PROVIDERS.find((p) => p.id === id));
  });

  it.each(["", "paseo", "Claude", "claude ", "gemini", "__proto__", "constructor", "toString", "hasOwnProperty"])(
    "throws on unknown id %j (fail closed, never a default)",
    (id: string) => {
      expect(() => getProvider(id)).toThrow(/unknown provider/i);
    },
  );

  it("names the known providers in the error", () => {
    expect(() => getProvider("nope")).toThrow(/claude.*codex.*opencode/);
  });
});
