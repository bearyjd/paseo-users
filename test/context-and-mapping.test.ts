import { describe, expect, it } from "vitest";
import {
  NO_CORE_ENFORCEMENT,
  PASEO_DAEMON_PERMISSIONS,
  buildUsersContext,
  daemonPermissionsFor,
  type CoreEnforcement,
} from "../server/kernel/index.js";
import { evaluateProfileRequest, ProfileRequestV1Schema, UsersContextV1Schema } from "../shared/profiles-contract.js";
import { makeHousehold } from "./helpers.js";

const FULL: CoreEnforcement = { principalAdmission: true, resourceScopedGrants: true, redactedDaemonRead: true, pluginCallerIdentity: true };

describe("daemon permission mapping fails closed", () => {
  it("pins the upstream daemon permission vocabulary (v0.17.5)", () => {
    expect([...PASEO_DAEMON_PERMISSIONS]).toEqual([
      "daemon.read", "daemon.manage", "tunnel.manage", "access.manage", "workspace.read",
      "workspace.write", "workspace.manage", "automation.manage", "hub.execute",
    ]);
  });

  it("grants nothing, to anyone, when the daemon cannot admit principals", async () => {
    const { admin, alice } = await makeHousehold();
    for (const p of [admin, alice]) {
      expect(daemonPermissionsFor(p.permissions, NO_CORE_ENFORCEMENT)).toEqual({ ok: false, permissions: [], blockedBy: ["principalAdmission"] });
    }
  });

  it("refuses developer workspace access until the daemon can scope it", async () => {
    const { alice } = await makeHousehold();
    const result = daemonPermissionsFor(alice.permissions, { ...NO_CORE_ENFORCEMENT, principalAdmission: true });
    expect(result).toMatchObject({ ok: false, permissions: [] });
    expect((result as { blockedBy: string[] }).blockedBy).toEqual(["resourceScopedGrants", "redactedDaemonRead"]);
  });

  it("with full enforcement a developer never receives daemon, tunnel, access, hub or automation authority", async () => {
    const { alice, admin } = await makeHousehold();
    const dev = daemonPermissionsFor(alice.permissions, FULL);
    expect(dev).toEqual({ ok: true, permissions: ["daemon.read", "workspace.read", "workspace.write", "workspace.manage"] });
    for (const forbidden of ["daemon.manage", "access.manage", "tunnel.manage", "automation.manage", "hub.execute"]) {
      expect((dev as { permissions: string[] }).permissions).not.toContain(forbidden);
    }
    expect(daemonPermissionsFor(admin.permissions, FULL)).toMatchObject({ ok: true, permissions: [...PASEO_DAEMON_PERMISSIONS] });
  });
});

describe("Profiles integration contract v1", () => {
  it("is empty and marked unenforced when the daemon is not enforcing, even for a logged-in user", async () => {
    const { kernel, alice } = await makeHousehold();
    const ctx = await buildUsersContext(kernel, alice, NO_CORE_ENFORCEMENT);
    expect(UsersContextV1Schema.parse(ctx)).toMatchObject({ enforcement: "none", user: null, capabilities: [] });
  });

  it("exposes only the caller's own allowances", async () => {
    const { kernel, admin, alice, bob, aliceId } = await makeHousehold();
    await kernel.grantAllowance(admin, aliceId, "provider", "claude");
    await kernel.grantAllowance(admin, aliceId, "credential", "github:alice");
    const a = await buildUsersContext(kernel, alice, FULL);
    const b = await buildUsersContext(kernel, bob, FULL);
    expect(a.permitted.providers).toEqual(["claude"]);
    expect(a.permitted.credentialRefs).toEqual(["github:alice"]);
    expect(b.permitted.providers).toEqual([]);
    expect(JSON.stringify(a)).not.toMatch(/scrypt|token/i);
  });

  it("selecting or editing a profile cannot grant anything the user was not allowed", async () => {
    const { kernel, admin, alice, aliceId } = await makeHousehold();
    await kernel.grantAllowance(admin, aliceId, "provider", "claude");
    await kernel.grantAllowance(admin, aliceId, "sandbox", "podman:default");
    const ctx = await buildUsersContext(kernel, alice, FULL);
    const greedy = ProfileRequestV1Schema.parse({
      providers: ["claude", "codex"],
      sandbox: "native",
      credentialRefs: ["github:admin-token"],
      profileId: "admin-profile",
    });
    const decision = evaluateProfileRequest(ctx, greedy);
    expect(decision.allowed).toBe(false);
    expect(decision.granted).toEqual({ providers: ["claude"], sandbox: null, credentialRefs: [], profileId: null });
    expect(decision.denied.map((d) => d.ref).sort()).toEqual(["admin-profile", "codex", "github:admin-token", "native"]);
    const modest = evaluateProfileRequest(ctx, ProfileRequestV1Schema.parse({ providers: ["claude"], sandbox: "podman:default" }));
    expect(modest.allowed).toBe(true);
  });

  it("an unenforced context vouches for nothing", async () => {
    const { kernel, alice } = await makeHousehold();
    const ctx = await buildUsersContext(kernel, alice, NO_CORE_ENFORCEMENT);
    const d = evaluateProfileRequest(ctx, ProfileRequestV1Schema.parse({ providers: ["claude"], sandbox: "native" }));
    expect(d.allowed).toBe(false);
    expect(d.granted.providers).toEqual([]);
  });
});

describe("plugin status never overclaims", () => {
  it("reports enforcement none, listing every missing core capability", async () => {
    const { readStatus } = await import("../server/status.js");
    expect(readStatus()).toMatchObject({
      enforcement: "none",
      blockedBy: ["principalAdmission", "resourceScopedGrants", "redactedDaemonRead", "pluginCallerIdentity"],
    });
    expect(readStatus({ ...NO_CORE_ENFORCEMENT, principalAdmission: true }).enforcement).toBe("none");
  });
});
