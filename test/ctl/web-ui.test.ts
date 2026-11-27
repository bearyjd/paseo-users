import { describe, expect, it } from "vitest";
import { ConfigError, parseConfig } from "../../tools/ctl/config.js";
import { planHost, type Plan } from "../../tools/ctl/plan.js";
import { cfg } from "./helpers.js";

const unitOf = (p: Plan, name: string) => p.steps.find((s) => s.id === `${name}.unit`)?.file?.content ?? "";

describe("webUi", () => {
  it("is off by default: units do not enable the bundled web UI", () => {
    expect(unitOf(planHost(parseConfig(cfg({ people: [{ name: "ann" }] }))), "ann")).not.toContain("PASEO_WEB_UI_ENABLED");
  });

  it("enables the bundled web UI in every daemon's unit when set", () => {
    const plan = planHost(
      parseConfig(cfg({ webUi: true, people: [{ name: "ann" }, { name: "bob", isolation: "unix-account", unixAccount: "bob" }] })),
    );
    for (const name of ["ann", "bob"]) expect(unitOf(plan, name)).toContain("Environment=PASEO_WEB_UI_ENABLED=true\n");
  });

  it("false adds nothing, and a non-boolean is rejected", () => {
    expect(unitOf(planHost(parseConfig(cfg({ webUi: false, people: [{ name: "ann" }] }))), "ann")).not.toContain("PASEO_WEB_UI_ENABLED");
    expect(() => parseConfig(cfg({ webUi: "yes" }))).toThrow(ConfigError);
  });

  it("warns that the page itself is served without the password while the API stays protected", () => {
    const plan = planHost(parseConfig(cfg({ webUi: true, people: [{ name: "ann" }] })));
    expect(plan.warnings.join("\n")).toMatch(/web UI/i);
  });
});
