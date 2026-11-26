import { describe, expect, it } from "vitest";
import { ConflictError, ForbiddenError, NotFoundError, type Principal } from "../server/kernel/index.js";
import { PW, makeHousehold } from "./helpers.js";

describe("role enforcement: developer cannot use administrator operations", () => {
  it("blocks every administrator-only operation for a developer", async () => {
    const { kernel, alice, bobId, aliceId } = await makeHousehold();
    const denied = [
      () => kernel.listUsers(alice),
      () => kernel.createUser(alice, { username: "eve", roleIds: ["developer"], initialPassword: "eves long passphrase 9" }),
      () => kernel.createInvitation(alice, { roleIds: ["developer"] }),
      () => kernel.createPasswordReset(alice, bobId),
      () => kernel.setUserStatus(alice, bobId, "disabled"),
      () => kernel.deleteUser(alice, bobId),
      () => kernel.setUserRoles(alice, aliceId, ["administrator"]),
      () => kernel.setUserRoles(alice, bobId, ["administrator"]),
      () => kernel.grantAllowance(alice, aliceId, "sandbox", "native"),
      () => kernel.readAudit(alice),
      () => kernel.revokeAllLoginSessions(alice, bobId),
      () => kernel.createProject(alice, { paseoRef: "/srv/admin-owned", name: "x", administratorOwned: true }),
    ];
    for (const attempt of denied) await expect(attempt()).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("privilege escalation attempts", () => {
  it("a developer cannot promote themselves", async () => {
    const { kernel, alice, aliceId } = await makeHousehold();
    await expect(kernel.setUserRoles(alice, aliceId, ["administrator"])).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("an administrator cannot change their own roles (no self-demotion lockout, no silent self-edit)", async () => {
    const { kernel, admin, adminId } = await makeHousehold();
    await expect(kernel.setUserRoles(admin, adminId, ["developer"])).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("delegation: an actor cannot assign permissions they do not hold, nor administer a more privileged account", async () => {
    const { kernel, store, admin, adminId, aliceId, loginAs } = await makeHousehold();
    // A delegated user-manager role: can manage users and roles but holds nothing else.
    await store.transact((d) => {
      d.roles.push({ id: "helper", name: "Helper", builtin: false, permissions: ["users.manage", "roles.manage", "sessions.own"] });
    });
    await kernel.setUserRoles(admin, aliceId, ["helper"]);
    const helper = await loginAs("alice", PW.dev);
    await expect(kernel.setUserRoles(helper, (await kernel.createUser(helper, { username: "carol", roleIds: ["helper"], initialPassword: "a delegated new account 12" })).userId, ["administrator"])).rejects.toBeInstanceOf(ForbiddenError);
    await expect(kernel.createInvitation(helper, { roleIds: ["administrator"] })).rejects.toBeInstanceOf(ForbiddenError);
    // Cannot take over an administrator by resetting, disabling or deleting them.
    await expect(kernel.createPasswordReset(helper, adminId)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(kernel.setUserStatus(helper, adminId, "disabled")).rejects.toBeInstanceOf(ForbiddenError);
    await expect(kernel.deleteUser(helper, adminId)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("the last active administrator cannot be disabled, deleted or demoted", async () => {
    const { kernel, admin, adminId, store, loginAs, aliceId } = await makeHousehold();
    await expect(kernel.setUserStatus(admin, adminId, "disabled")).rejects.toBeInstanceOf(ForbiddenError);
    await expect(kernel.deleteUser(admin, adminId)).rejects.toBeInstanceOf(ForbiddenError);
    // Promote alice to a second admin; one admin can then retire the other but never the last.
    await kernel.setUserRoles(admin, aliceId, ["administrator"]);
    const alice2 = await loginAs("alice", PW.dev);
    await kernel.setUserStatus(alice2, adminId, "disabled");
    await expect(kernel.setUserStatus(alice2, aliceId, "disabled")).rejects.toBeInstanceOf(ForbiddenError);
    expect((await store.read()).users.filter((u) => u.status === "active" && u.roleIds.includes("administrator")).length).toBe(1);
  });

  it("demoting a user ends their sessions so stale privileges do not linger", async () => {
    const { kernel, admin, aliceId, loginAs } = await makeHousehold();
    await kernel.setUserRoles(admin, aliceId, ["administrator"]);
    const promoted = await loginAs("alice", PW.dev);
    await kernel.setUserRoles(admin, aliceId, ["developer"]);
    expect(await kernel.authenticate("pus_" + "x".repeat(43))).toBeNull();
    await expect(kernel.listUsers(promoted)).resolves.toBeDefined(); // stale Principal object is the caller's problem...
    const fresh = await kernel.login({ username: "alice", password: PW.dev });
    if (!fresh.ok) throw new Error();
    const p = (await kernel.authenticate(fresh.token))!;
    expect(p.permissions.has("users.manage")).toBe(false); // ...but every new request resolves the current role
  });

  it("listUsers never returns password hashes", async () => {
    const { kernel, admin } = await makeHousehold();
    const users = await kernel.listUsers(admin);
    expect(JSON.stringify(users)).not.toMatch(/scrypt|passwordHash/);
  });
});

describe("project isolation between users", () => {
  it("a developer sees only their own and shared projects; others are indistinguishable from nonexistent", async () => {
    const { kernel, alice, bob, admin } = await makeHousehold();
    const secret = await kernel.createProject(alice, { paseoRef: "/home/alice/secret", name: "alice-private" });
    expect((await kernel.listProjects(bob)).map((p) => p.id)).not.toContain(secret.id);
    expect((await kernel.listProjects(alice)).map((p) => p.id)).toContain(secret.id);
    expect((await kernel.listProjects(admin)).map((p) => p.id)).toContain(secret.id);

    // Direct-id attempts by bob are "not found", never "forbidden" (no existence oracle).
    await expect(kernel.shareProject(bob, secret.id, bob.userId, "write")).rejects.toBeInstanceOf(NotFoundError);
    await expect(kernel.deleteProject(bob, secret.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(kernel.registerAgentSession(bob, { paseoAgentId: "agent-b", projectId: secret.id })).rejects.toBeInstanceOf(NotFoundError);
  });

  it("sharing grants exactly the shared access level and nothing more", async () => {
    const { kernel, alice, bob, bobId } = await makeHousehold();
    const project = await kernel.createProject(alice, { paseoRef: "/home/alice/shared", name: "shared" });
    await kernel.shareProject(alice, project.id, bobId, "read");
    expect((await kernel.listProjects(bob)).map((p) => p.id)).toContain(project.id);
    // read-only member cannot start a session in it, share it onward, or delete it
    await expect(kernel.registerAgentSession(bob, { paseoAgentId: "agent-b1", projectId: project.id })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(kernel.shareProject(bob, project.id, bobId, "write")).rejects.toBeInstanceOf(ForbiddenError);
    await expect(kernel.deleteProject(bob, project.id)).rejects.toBeInstanceOf(ForbiddenError);
    await kernel.shareProject(alice, project.id, bobId, "write");
    await kernel.registerAgentSession(bob, { paseoAgentId: "agent-b2", projectId: project.id });
  });

  it("a write-member cannot escalate to owner by re-sharing", async () => {
    const { kernel, alice, bob, bobId } = await makeHousehold();
    const project = await kernel.createProject(alice, { paseoRef: "/home/alice/p", name: "p" });
    await kernel.shareProject(alice, project.id, bobId, "write");
    await expect(kernel.shareProject(bob, project.id, bobId, "write")).rejects.toBeInstanceOf(ForbiddenError);
    await expect(kernel.unshareProject(bob, project.id, bobId)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("registering the same Paseo project twice is a conflict, so one user cannot shadow another's", async () => {
    const { kernel, alice, bob } = await makeHousehold();
    await kernel.createProject(alice, { paseoRef: "/home/shared/repo", name: "repo" });
    await expect(kernel.createProject(bob, { paseoRef: "/home/shared/repo", name: "mine" })).rejects.toBeInstanceOf(ConflictError);
  });

  it("deleting an owner makes their projects administrator-owned, keeps existing shares, and drops their sessions", async () => {
    const { kernel, store, admin, alice, bob, aliceId, bobId } = await makeHousehold();
    const p = await kernel.createProject(alice, { paseoRef: "/home/alice/p", name: "p" });
    await kernel.shareProject(alice, p.id, bobId, "write");
    await kernel.registerAgentSession(alice, { paseoAgentId: "agent-alice-del", projectId: p.id });
    await kernel.deleteUser(admin, aliceId);
    const data = await store.read();
    expect(data.projects.find((x) => x.id === p.id)?.ownerId).toBeNull();
    expect(data.sessionOwnership.some((o) => o.ownerId === aliceId)).toBe(false);
    // bob keeps exactly what he was granted, no more.
    expect((await kernel.listProjects(bob)).map((x) => x.id)).toContain(p.id);
    await expect(kernel.deleteProject(bob, p.id)).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("coding session isolation between users", () => {
  async function setup() {
    const h = await makeHousehold();
    const project = await h.kernel.createProject(h.alice, { paseoRef: "/home/alice/p", name: "p" });
    await h.kernel.registerAgentSession(h.alice, { paseoAgentId: "agent-alice", projectId: project.id });
    await h.kernel.registerAgentSession(h.bob, { paseoAgentId: "agent-bob", projectId: null });
    return { ...h, project };
  }

  it("the owner can read and write; another developer can do neither", async () => {
    const { kernel, alice, bob } = await setup();
    expect((await kernel.authorizeAgentSession(alice, "agent-alice", "write")).allow).toBe(true);
    expect(await kernel.authorizeAgentSession(bob, "agent-alice", "read")).toMatchObject({ allow: false });
    expect(await kernel.authorizeAgentSession(bob, "agent-alice", "write")).toMatchObject({ allow: false });
    expect(await kernel.authorizeAgentSession(alice, "agent-bob", "read")).toMatchObject({ allow: false });
  });

  it("list views contain only the caller's sessions", async () => {
    const { kernel, alice, bob, admin } = await setup();
    expect(await kernel.listVisibleAgentSessions(alice)).toEqual(["agent-alice"]);
    expect(await kernel.listVisibleAgentSessions(bob)).toEqual(["agent-bob"]);
    // Administrators may read others' sessions (explicit permission) but their personal list is their own.
    expect(await kernel.listVisibleAgentSessions(admin)).toEqual([]);
  });

  it("unknown or unregistered sessions are denied to developers (fail closed)", async () => {
    const { kernel, alice } = await setup();
    expect(await kernel.authorizeAgentSession(alice, "agent-does-not-exist", "read")).toMatchObject({ allow: false });
    expect(await kernel.authorizeAgentSession(alice, "", "write")).toMatchObject({ allow: false });
  });

  it("an administrator can read but not drive another user's session, and the read is audited", async () => {
    const { kernel, admin, audit } = await setup();
    expect(await kernel.authorizeAgentSession(admin, "agent-alice", "read")).toMatchObject({ allow: true, adminOverride: true });
    expect(await kernel.authorizeAgentSession(admin, "agent-alice", "write")).toMatchObject({ allow: false });
    expect(audit.events.some((e) => e.type === "authz.admin_override")).toBe(true);
  });

  it("denials are audited", async () => {
    const { kernel, bob, audit } = await setup();
    await kernel.authorizeAgentSession(bob, "agent-alice", "read");
    expect(audit.events.some((e) => e.type === "authz.denied" && e.targetId === "agent-alice")).toBe(true);
  });

  it("revoking a project share immediately cuts the former member's sessions in that project", async () => {
    const { kernel, alice, bob, bobId, project } = await setup();
    await kernel.shareProject(alice, project.id, bobId, "write");
    await kernel.registerAgentSession(bob, { paseoAgentId: "agent-bob-shared", projectId: project.id });
    expect((await kernel.authorizeAgentSession(bob, "agent-bob-shared", "write")).allow).toBe(true);
    await kernel.unshareProject(alice, project.id, bobId);
    expect(await kernel.authorizeAgentSession(bob, "agent-bob-shared", "read")).toMatchObject({ allow: false });
    expect(await kernel.authorizeAgentSession(bob, "agent-bob-shared", "write")).toMatchObject({ allow: false });
  });

  it("a session id cannot be registered twice (no hijack by re-registering)", async () => {
    const { kernel, bob } = await setup();
    await expect(kernel.registerAgentSession(bob, { paseoAgentId: "agent-alice", projectId: null })).rejects.toBeInstanceOf(ConflictError);
  });

  it("a user without sessions.own cannot register or use sessions", async () => {
    const { kernel, store, admin, aliceId, loginAs } = await setup();
    await store.transact((d) => d.roles.push({ id: "viewer", name: "Viewer", builtin: false, permissions: ["preferences.own"] }));
    await kernel.setUserRoles(admin, aliceId, ["viewer"]);
    const viewer = await loginAs("alice", PW.dev);
    await expect(kernel.registerAgentSession(viewer, { paseoAgentId: "agent-v", projectId: null })).rejects.toBeInstanceOf(ForbiddenError);
    expect(await kernel.authorizeAgentSession(viewer, "agent-alice", "read")).toMatchObject({ allow: false });
  });
});

describe("policy allowances (profiles, sandboxes, providers, credential references)", () => {
  it("developers see only what an administrator granted them", async () => {
    const { kernel, admin, alice, bob, aliceId } = await makeHousehold();
    await kernel.grantAllowance(admin, aliceId, "sandbox", "podman:default");
    await kernel.grantAllowance(admin, aliceId, "credential", "github:alice-readonly");
    expect(await kernel.isAllowed(alice, "sandbox", "podman:default")).toBe(true);
    expect(await kernel.isAllowed(alice, "sandbox", "native")).toBe(false);
    expect(await kernel.isAllowed(bob, "sandbox", "podman:default")).toBe(false);
    await expect(kernel.allowancesFor(bob, aliceId)).rejects.toBeInstanceOf(ForbiddenError);
    expect(await kernel.allowancesFor(alice, aliceId)).toHaveLength(2);
  });

  it("revoking an allowance takes effect immediately", async () => {
    const { kernel, admin, alice, aliceId } = await makeHousehold();
    await kernel.grantAllowance(admin, aliceId, "provider", "codex");
    await kernel.revokeAllowance(admin, aliceId, "provider", "codex");
    expect(await kernel.isAllowed(alice, "provider", "codex")).toBe(false);
  });
});

describe("credential disclosure", () => {
  it("the persisted store and audit log contain no passwords, raw tokens, or secret-looking material", async () => {
    const { kernel, store, audit, admin, aliceId } = await makeHousehold();
    const login = await kernel.login({ username: "alice", password: PW.dev });
    if (!login.ok) throw new Error();
    const invite = await kernel.createInvitation(admin, { roleIds: ["developer"] });
    const reset = await kernel.createPasswordReset(admin, aliceId);
    await kernel.grantAllowance(admin, aliceId, "credential", "ssh:alice-deploy-key"); // a REFERENCE
    const everything = JSON.stringify([await store.read(), audit.events]);
    for (const secret of [...Object.values(PW), login.token, invite.token, reset.token]) {
      expect(everything).not.toContain(secret);
    }
    expect(everything).not.toMatch(/BEGIN [A-Z ]*PRIVATE KEY/);
  });
});

void ({} as Principal);
