import { describe, expect, it } from "vitest";
import { ConfigError, parseConfig } from "../../tools/ctl/config.js";
import { planHost, type Plan } from "../../tools/ctl/plan.js";
import { cfg } from "./helpers.js";

const unitOf = (p: Plan, name: string) => p.steps.find((s) => s.id === `${name}.unit`)?.file?.content ?? "";
const PATH = "/home/tester/.local/bin:/home/tester/.local/npm/bin:/usr/local/bin:/usr/bin:/bin";

describe("environmentPath", () => {
  it("sets PATH in same-user units so provider CLIs are found under systemd's minimal environment", () => {
    const plan = planHost(parseConfig(cfg({ environmentPath: PATH, people: [{ name: "ann" }] })));
    expect(unitOf(plan, "ann")).toContain(`Environment=PATH=${PATH}\n`);
  });

  it("adds no PATH line when unset", () => {
    expect(unitOf(planHost(parseConfig(cfg({ people: [{ name: "ann" }] }))), "ann")).not.toContain("PATH=");
  });

  it("never copies the operator's PATH into another Linux user's unit", () => {
    const plan = planHost(
      parseConfig(cfg({ environmentPath: PATH, people: [{ name: "ann", isolation: "unix-account", unixAccount: "ann" }] })),
    );
    expect(unitOf(plan, "ann")).not.toContain("PATH=");
  });

  it("accepts %h (the user's home) at the start of an entry, as systemd units commonly write PATH", () => {
    const value = "%h/.local/bin:%h:/usr/local/bin:/usr/bin";
    const plan = planHost(parseConfig(cfg({ environmentPath: value, people: [{ name: "ann" }] })));
    expect(unitOf(plan, "ann")).toContain(`Environment=PATH=${value}\n`);
  });

  it.each([
    ["relative element", "bin:/usr/bin"],
    ["whitespace", "/usr/bin /bin"],
    ["newline injection", "/usr/bin\nExecStartPre=/bin/evil"],
    ["quote", '/usr/"bin'],
    ["specifier in the middle of an entry", "/usr/%h/bin"],
    ["other specifier", "%u/bin:/usr/bin"],
    ["specifier not followed by a path", "%hbin:/usr/bin"],
    ["empty element", "/usr/bin::/bin"],
    ["empty string", ""],
  ])("rejects %s", (_label, value) => {
    expect(() => parseConfig(cfg({ environmentPath: value }))).toThrow(ConfigError);
  });
});
