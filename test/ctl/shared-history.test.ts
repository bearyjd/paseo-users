import { describe, expect, it } from "vitest";
import { parseConfig } from "../../tools/ctl/config.js";
import { planHost } from "../../tools/ctl/plan.js";
import { cfg } from "./helpers.js";

const warnings = (raw: Record<string, unknown>) => planHost(parseConfig(raw)).warnings.join("\n");

describe("shared provider history warning", () => {
  it("warns when same-user daemons share a home with another daemon: past provider sessions and project directories are visible to both", () => {
    const text = warnings(cfg({ people: [{ name: "ann" }, { name: "bob" }] }));
    expect(text).toMatch(/provider session history/i);
    expect(text).toMatch(/import/i);
  });

  it("warns for one same-user daemon next to an existing daemon", () => {
    expect(warnings(cfg({ existingDaemons: [{ name: "main", port: 7000 }], people: [{ name: "ann" }] }))).toMatch(/provider session history/i);
  });

  it("does not warn for a lone daemon, or for unix-account people (their homes are separate)", () => {
    expect(warnings(cfg({ people: [{ name: "ann" }] }))).not.toMatch(/provider session history/i);
    expect(warnings(cfg({ people: [{ name: "ann", isolation: "unix-account", unixAccount: "ann" }, { name: "bob", isolation: "unix-account", unixAccount: "bob" }] }))).not.toMatch(/provider session history/i);
  });
});
