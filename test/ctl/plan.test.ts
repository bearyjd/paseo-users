import { describe, expect, it } from "vitest";
import { parseConfig } from "../../tools/ctl/config.js";
import { createRegistry, type IsolationStrategy } from "../../tools/ctl/isolation/index.js";
import { defaultRegistry } from "../../tools/ctl/isolation/registry.js";
import { sameUser } from "../../tools/ctl/isolation/same-user.js";
import { planHost, planRevoke, type Plan } from "../../tools/ctl/plan.js";
import { stepArgv } from "../../tools/ctl/shell.js";
import { cfg } from "./helpers.js";

const argvs = (p: Plan) => p.steps.map((s) => stepArgv(s)).filter((a): a is string[] => !!a);
const flat = (p: Plan) => JSON.stringify(p);
const unitOf = (p: Plan, name: string) => p.steps.find((s) => s.id === `${name}.unit`)?.file?.content ?? "";

describe("same-user plan", () => {
  const plan = planHost(parseConfig(cfg()));

  it("gives each person a distinct home and port", () => {
    expect(new Set(plan.people.map((p) => p.paseoHome)).size).toBe(2);
    expect(new Set(plan.people.map((p) => p.port)).size).toBe(2);
    expect(plan.people.every((p) => !p.paseoHome.endsWith("/.paseo"))).toBe(true);
  });

  it("creates no accounts and changes nothing outside the user's own manager", () => {
    const text = argvs(plan).map((a) => a.join(" ")).join("\n");
    for (const banned of ["useradd", "usermod", "userdel", "passwd", "sudo", "chown"]) expect(text).not.toContain(banned);
    expect(plan.steps.some((s) => s.privileged && s.kind !== "manual")).toBe(false);
    expect(argvs(plan)).toContainEqual(["systemctl", "--user", "daemon-reload"]);
    expect(argvs(plan)).toContainEqual(["systemctl", "--user", "enable", "--now", "paseo-ann.service"]);
  });

  it("renders a user unit that reads the password from an EnvironmentFile", () => {
    const u = unitOf(plan, "ann");
    expect(u).toContain("ExecStart=/opt/paseo/bin/paseo daemon run --home /home/tester/.paseo-people/ann");
    expect(u).toContain("Environment=PASEO_HOME=/home/tester/.paseo-people/ann");
    expect(u).toContain("Environment=PASEO_LISTEN=127.0.0.1:7100");
    expect(u).toContain("Environment=PASEO_RELAY_ENABLED=false");
    expect(u).toContain("EnvironmentFile=/home/tester/.paseo-people/ann.env");
    expect(u).toContain("Restart=on-failure");
    expect(u).toContain("NoNewPrivileges=yes");
    expect(u).toContain("PrivateTmp=yes");
    expect(u).not.toContain("ProtectHome");
    expect(u).not.toMatch(/PASSWORD=/);
    expect(plan.steps.find((s) => s.id === "ann.secret-env")?.file).toMatchObject({ mode: "0600", secretRef: "ann" });
    expect(plan.steps.find((s) => s.id === "ann.secret-env")?.file?.content).toBeUndefined();
  });

  it("warns that it is not OS isolation, only when more than one daemon exists", () => {
    expect(plan.warnings.join("\n")).toMatch(/same-user isolation is not OS isolation/);
    const one = planHost(parseConfig(cfg({ people: [{ name: "ann" }] })));
    expect(one.warnings.join("\n")).not.toMatch(/not OS isolation/);
  });

  it("warns about an existing daemon the agents might read", () => {
    const p = planHost(parseConfig(cfg({ existingDaemons: [{ name: "main", port: 6767 }] })));
    expect(p.warnings.join("\n")).toMatch(/existingDaemons/);
  });

  it("has a manual linger step and manual verification, and verify steps are not in steps", () => {
    expect(plan.steps.find((s) => s.id === "same-user.linger")).toMatchObject({ kind: "manual", privileged: true });
    const ids = plan.verify.map((s) => s.id);
    expect(ids).toContain("ann.verify-health");
    expect(ids).toContain("ann.bob.verify-distinct-homes");
    expect(plan.verify.find((s) => s.id === "ann.verify-app")?.kind).toBe("manual");
    expect(plan.steps.some((s) => s.id.includes("verify"))).toBe(false);
    expect(plan.verify.find((s) => s.id === "ann.verify-health")?.command?.join(" ")).toContain("http://127.0.0.1:7100/api/health");
  });

  it("is deterministic", () => {
    expect(flat(planHost(parseConfig(cfg())))).toBe(flat(plan));
  });
});

describe("unix-account plan", () => {
  const raw = cfg({ people: [{ name: "cy", isolation: "unix-account", unixAccount: "svc-cy" }] });
  const plan = planHost(parseConfig(raw));
  const get = (id: string) => plan.steps.find((s) => s.id === id);

  it("creates the account, locks it, and enables linger, all privileged", () => {
    expect(get("cy.useradd")).toMatchObject({ privileged: true });
    expect(get("cy.useradd")?.command).toEqual(["useradd", "--create-home", "--home-dir", "/home/svc-cy", "--shell", "/bin/bash", "--user-group", "svc-cy"]);
    expect(get("cy.lock-password")?.command).toEqual(["passwd", "-l", "svc-cy"]);
    expect(get("cy.linger")?.command).toEqual(["loginctl", "enable-linger", "svc-cy"]);
    for (const s of plan.steps.filter((x) => x.kind !== "manual")) expect(s.privileged, s.id).toBe(true);
  });

  it("uses 0700 directories and files owned by the account, away from ~/.paseo", () => {
    expect(get("cy.account-home")?.dir).toEqual({ path: "/home/svc-cy", mode: "0700", owner: "svc-cy" });
    expect(get("cy.paseo-home")?.dir).toEqual({ path: "/home/svc-cy/.paseo-daemon", mode: "0700", owner: "svc-cy" });
    expect(get("cy.secret-env")?.file).toMatchObject({ mode: "0600", owner: "svc-cy", secretRef: "cy" });
    expect(get("cy.unit")?.file).toMatchObject({ path: "/home/svc-cy/.config/systemd/user/paseo-cy.service", owner: "svc-cy" });
    expect(unitOf(plan, "cy")).toContain("EnvironmentFile=-/home/svc-cy/.paseo-provider.env");
    expect(unitOf(plan, "cy")).not.toContain("ProtectHome");
  });

  it("warns that LLM logins are not shared and has a manual login step", () => {
    expect(plan.warnings.join("\n")).toMatch(/LLM logins are not shared/);
    expect(get("cy.llm-login")?.kind).toBe("manual");
    expect(get("cy.llm-login")?.description).toContain("UNVERIFIED");
    expect(plan.warnings.join("\n")).not.toMatch(/not OS isolation/);
  });

  it("honours unixAccountHomeBase", () => {
    const p = planHost(parseConfig({ ...raw, unixAccountHomeBase: "/srv/people" }));
    expect(p.people[0]?.paseoHome).toBe("/srv/people/svc-cy/.paseo-daemon");
  });
});

describe("mixed config", () => {
  const raw = cfg({
    people: [
      { name: "ann" },
      { name: "bob", isolation: "unix-account", unixAccount: "svc-bob" },
      { name: "cy", isolation: "unix-account", unixAccount: "svc-cy" },
    ],
  });
  const plan = planHost(parseConfig(raw));

  it("applies each strategy to its own person and warns for both", () => {
    expect(plan.steps.some((s) => s.id === "ann.unit" && !s.privileged)).toBe(true);
    expect(plan.steps.some((s) => s.id === "bob.useradd")).toBe(true);
    expect(plan.steps.some((s) => s.id === "ann.useradd")).toBe(false);
    expect(plan.warnings.join("\n")).toMatch(/LLM logins are not shared.*bob, cy/);
  });

  it("verifies unreadability between accounts and from accounts to same-user homes", () => {
    const cmds = plan.verify.map((s) => s.command?.join(" ") ?? "");
    expect(cmds).toContain("sudo -u svc-cy test ! -r /home/svc-bob/.paseo-daemon");
    expect(cmds).toContain("sudo -u svc-bob test ! -r /home/svc-cy/.paseo-daemon");
    expect(cmds).toContain("sudo -u svc-bob test ! -r /home/tester/.paseo-people/ann");
    expect(plan.verify.filter((s) => s.command?.[0] === "sudo").every((s) => s.privileged)).toBe(true);
  });

  it("keeps ports distinct", () => {
    expect(new Set(plan.people.map((p) => p.port)).size).toBe(3);
  });
});

describe("revoke plans", () => {
  it("same-user: stop, disable, rotate, and admit its limits", () => {
    const p = planRevoke(parseConfig(cfg()), "bob");
    expect(argvs(p)).toContainEqual(["systemctl", "--user", "disable", "--now", "paseo-bob.service"]);
    expect(p.rotate).toEqual(["bob"]);
    expect(p.steps.find((s) => s.id === "bob.secret-env")?.file?.secretRef).toBe("bob");
    expect(p.steps.find((s) => s.id === "bob.revoke-note")?.description).toMatch(/cannot stop a revoked person's agents from reading/);
    expect(p.warnings.join("\n")).toMatch(/cannot undo/);
    expect(p.people.map((x) => x.name)).toEqual(["bob"]);
  });

  it("unix-account: disable, rotate, lock, terminate; all privileged", () => {
    const p = planRevoke(parseConfig(cfg({ people: [{ name: "cy", isolation: "unix-account", unixAccount: "svc-cy" }] })), "cy");
    const a = argvs(p).map((x) => x.join(" "));
    expect(a).toContain("systemctl --machine=svc-cy@.host --user disable --now paseo-cy.service");
    expect(a).toContain("usermod -L svc-cy");
    expect(p.steps.filter((s) => s.kind !== "manual").every((s) => s.privileged)).toBe(true);
  });

  it("rejects an unknown person", () => {
    expect(() => planRevoke(parseConfig(cfg()), "nobody")).toThrow(/unknown person/);
  });
});

describe("registry extension point", () => {
  it("plans through a custom strategy without touching the planner", () => {
    const fake: IsolationStrategy = {
      id: "fake",
      validate: () => [],
      paseoHome: (p) => `/x/${p.name}`,
      plan: (p) => [{ id: `${p.name}.noop`, description: "noop", kind: "manual" }],
      revoke: () => [],
      verify: () => [],
    };
    const registry = createRegistry([sameUser, fake]);
    const ctx = parseConfig(cfg({ people: [{ name: "ann", isolation: "fake" }] }), registry);
    expect(planHost(ctx, registry).steps.map((s) => s.id)).toEqual(["ann.noop"]);
    expect(() => parseConfig(cfg({ people: [{ name: "ann", isolation: "fake" }] }), defaultRegistry)).toThrow(/unknown isolation/);
  });

  it("rejects duplicate strategy ids", () => {
    expect(() => createRegistry([sameUser, sameUser])).toThrow(/duplicate/);
  });
});
