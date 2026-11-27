import { describe, expect, it } from "vitest";
import { parseConfig } from "../../tools/ctl/config.js";
import { planHost, planRevoke, planForPerson, type Plan } from "../../tools/ctl/plan.js";
import { getProvider } from "../../tools/ctl/providers.js";
import { stepArgv } from "../../tools/ctl/shell.js";
import { rawCfg } from "./helpers.js";

const VERSION = "0.17.4";
// Operator-side values that must never reach a separate person's plan. BASE.userHome is /home/tester.
const OPERATOR_PATHS = ["/home/tester", "/opt/paseo/bin/paseo", "/opt/operator-tools/bin", "operator-secret-dir"];
const sep = (extra: Record<string, unknown> = {}) => ({
  name: "ann",
  isolation: "unix-account",
  unixAccount: "acct-ann",
  install: "separate",
  providers: ["claude", "codex"],
  ...extra,
});
const config = (people: Record<string, unknown>[] = [sep()], extra: Record<string, unknown> = {}) =>
  parseConfig(rawCfg({ paseoVersion: VERSION, environmentPath: "%h/operator-secret-dir:/opt/operator-tools/bin", people, ...extra }));

const unitOf = (p: Plan, name: string) => p.steps.find((s) => s.id === `${name}.unit`)?.file?.content ?? "";
const idx = (p: Plan, id: string) => p.steps.findIndex((s) => s.id === id);
const AS_ACCT = ["runuser", "-u", "acct-ann", "--", "env", "HOME=/home/acct-ann", "PATH=/usr/local/bin:/usr/bin:/bin"];

describe("separate install plan: nothing of the operator's leaks", () => {
  const ctx = config([sep(), sep({ name: "bob", unixAccount: "acct-bob", providers: ["opencode"] })]);
  const parts: [string, Plan][] = [
    ["host plan", planHost(ctx)],
    ["one person's part", planForPerson(planHost(ctx), "ann")],
    ["revoke plan", planRevoke(ctx, "ann")],
  ];

  it.each(parts)("%s contains no operator path, host paseoBinary or environmentPath", (_label, plan) => {
    const text = JSON.stringify(plan);
    for (const bad of OPERATOR_PATHS) expect(text, bad).not.toContain(bad);
  });

  it("the unit runs the account's own paseo, not the host binary", () => {
    const unit = unitOf(planHost(ctx), "ann");
    expect(unit).toContain("ExecStart=/home/acct-ann/.local/npm/bin/paseo daemon run --home /home/acct-ann/.paseo-daemon");
    expect(unit).not.toContain("/opt/paseo/bin/paseo");
  });

  it("the unit PATH is built from the account's own directories only", () => {
    const unit = unitOf(planHost(ctx), "ann");
    expect(unit).toContain("Environment=PATH=/home/acct-ann/.local/npm/bin:/usr/local/bin:/usr/bin:/bin\n");
    expect(unitOf(planHost(ctx), "bob")).toContain("Environment=PATH=/home/acct-bob/.local/npm/bin:/usr/local/bin:/usr/bin:/bin\n");
  });
});

describe("separate install plan: install steps", () => {
  const plan = planHost(config());
  const argvOf = (id: string) => {
    const s = plan.steps.find((x) => x.id === id);
    expect(s, id).toBeDefined();
    return s ? stepArgv(s) : undefined;
  };

  it("creates the npm prefix inside the account home, owned by the account, parents first", () => {
    expect(plan.steps.find((s) => s.id === "ann.local-dir")?.dir).toEqual({ path: "/home/acct-ann/.local", mode: "0700", owner: "acct-ann" });
    expect(plan.steps.find((s) => s.id === "ann.npm-prefix")?.dir).toEqual({ path: "/home/acct-ann/.local/npm", mode: "0700", owner: "acct-ann" });
    expect(idx(plan, "ann.local-dir")).toBeLessThan(idx(plan, "ann.npm-prefix"));
  });

  it("installs the pinned paseo into the account prefix as the account", () => {
    expect(argvOf("ann.install-paseo")).toEqual([
      ...AS_ACCT,
      "npm", "install", "--global", "--prefix", "/home/acct-ann/.local/npm", `@getpaseo/cli@${VERSION}`,
    ]);
  });

  it("installs each listed provider from the catalog, in the written order", () => {
    expect(argvOf("ann.install-claude")).toEqual([
      ...AS_ACCT,
      "npm", "install", "--global", "--prefix", "/home/acct-ann/.local/npm", getProvider("claude").npmPackage,
    ]);
    expect(argvOf("ann.install-codex")).toEqual([
      ...AS_ACCT,
      "npm", "install", "--global", "--prefix", "/home/acct-ann/.local/npm", getProvider("codex").npmPackage,
    ]);
    expect(plan.steps.some((s) => s.id === "ann.install-opencode")).toBe(false);
    expect(idx(plan, "ann.install-claude")).toBeLessThan(idx(plan, "ann.install-codex"));
  });

  it("installs before the unit and the daemon start, after the prefix exists", () => {
    expect(idx(plan, "ann.npm-prefix")).toBeLessThan(idx(plan, "ann.install-paseo"));
    expect(idx(plan, "ann.install-paseo")).toBeLessThan(idx(plan, "ann.install-claude"));
    expect(idx(plan, "ann.install-codex")).toBeLessThan(idx(plan, "ann.unit"));
    expect(idx(plan, "ann.install-codex")).toBeLessThan(idx(plan, "ann.enable"));
  });

  it("makes every install step privileged (root runs runuser) and never shells out", () => {
    for (const id of ["ann.install-paseo", "ann.install-claude", "ann.install-codex"]) {
      const s = plan.steps.find((x) => x.id === id);
      expect(s?.kind).toBe("command");
      expect(s?.privileged).toBe(true);
    }
    for (const s of plan.steps) {
      const argv = stepArgv(s);
      if (!argv) continue;
      expect(["sh", "bash", "-c"].some((x) => argv.includes(x)), s.id).toBe(false);
    }
  });

  it("keeps the manual login step, naming each provider's login hint and the account", () => {
    const login = plan.steps.find((s) => s.id === "ann.llm-login");
    expect(login?.kind).toBe("manual");
    expect(login?.description).toContain(getProvider("claude").loginHint);
    expect(login?.description).toContain(getProvider("codex").loginHint);
    expect(login?.description).toContain("acct-ann");
    expect(login?.description).toMatch(/UNVERIFIED/);
  });

  it("adds a hand-run check that the account's paseo starts", () => {
    const v = planHost(config()).verify.find((s) => s.id === "ann.verify-install");
    expect(v && stepArgv(v)).toEqual([...AS_ACCT, "/home/acct-ann/.local/npm/bin/paseo", "--version"]);
  });

  it("honours unixAccountHomeBase", () => {
    const p = planHost(config([sep()], { unixAccountHomeBase: "/srv/people" }));
    expect(unitOf(p, "ann")).toContain("ExecStart=/srv/people/acct-ann/.local/npm/bin/paseo daemon run");
    expect(JSON.stringify(p)).not.toContain("/home/acct-ann");
  });
});

describe("a unix-account person without install keeps today's plan exactly", () => {
  const ctx = parseConfig(rawCfg({ environmentPath: "/opt/operator-tools/bin", people: [{ name: "cy", isolation: "unix-account", unixAccount: "svc-cy" }] }));
  const plan = planHost(ctx);

  it("uses the host paseoBinary and has no PATH, install or provider steps", () => {
    const unit = unitOf(plan, "cy");
    expect(unit).toContain("ExecStart=/opt/paseo/bin/paseo daemon run --home /home/svc-cy/.paseo-daemon");
    expect(unit).not.toContain("Environment=PATH=");
    expect(plan.steps.map((s) => s.id).filter((id) => /install|npm|local/.test(id))).toEqual([]);
    expect(plan.verify.some((s) => s.id.endsWith("verify-install"))).toBe(false);
  });

  it("keeps the generic login hint", () => {
    expect(plan.steps.find((s) => s.id === "cy.llm-login")?.description).toContain("LLM logins are NOT shared");
  });
});

describe("a separate person beside a person who is not separate", () => {
  it("only the separate person gets install steps and the account binary", () => {
    const p = planHost(config([sep(), { name: "cy", isolation: "unix-account", unixAccount: "svc-cy" }]));
    expect(p.steps.some((s) => s.id === "ann.install-paseo")).toBe(true);
    expect(p.steps.some((s) => s.id === "cy.install-paseo")).toBe(false);
    expect(unitOf(p, "cy")).toContain("ExecStart=/opt/paseo/bin/paseo");
    expect(unitOf(p, "ann")).toContain("ExecStart=/home/acct-ann/.local/npm/bin/paseo");
  });
});
