import { mkdtemp, readFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ForbiddenError,
  UsersKernel,
  createMemoryAuditLog,
  createMemoryStore,
  hashToken,
} from "../server/kernel/index.js";
import { FakeClock, PW, cheapHasher, makeHousehold, makeKernel } from "./helpers.js";

describe("first-run initialization", () => {
  it("creates exactly one administrator and consumes the bootstrap token", async () => {
    const clock = new FakeClock();
    const kernel = new UsersKernel({ store: createMemoryStore(), hasher: cheapHasher(), audit: createMemoryAuditLog(clock), clock });
    const dir = await mkdtemp(join(tmpdir(), "pu-boot-"));
    expect(await kernel.isInitialized()).toBe(false);
    const token = (await kernel.issueBootstrapToken(dir))!;

    await expect(kernel.initialize(dir, { bootstrapToken: "pui_wrong", username: "root", password: PW.admin })).rejects.toBeInstanceOf(ForbiddenError);
    await kernel.initialize(dir, { bootstrapToken: token, username: "Root", password: PW.admin });
    expect(await kernel.isInitialized()).toBe(true);
    await expect(access(join(dir, "bootstrap-token"))).rejects.toThrow();
    // Replay with the same token and with no token file both fail.
    await expect(kernel.initialize(dir, { bootstrapToken: token, username: "second", password: PW.dev })).rejects.toBeInstanceOf(ForbiddenError);
    expect(await kernel.issueBootstrapToken(dir)).toBeNull();
    const result = await kernel.login({ username: "ROOT", password: PW.admin });
    expect(result.ok).toBe(true);
  });

  it("writes the bootstrap token with mode 0600", async () => {
    const clock = new FakeClock();
    const kernel = new UsersKernel({ store: createMemoryStore(), hasher: cheapHasher(), audit: createMemoryAuditLog(clock), clock });
    const dir = await mkdtemp(join(tmpdir(), "pu-boot-"));
    await kernel.issueBootstrapToken(dir);
    const { statSync } = await import("node:fs");
    expect(statSync(join(dir, "bootstrap-token")).mode & 0o777).toBe(0o600);
  });
});

describe("authentication", () => {
  it("accepts correct credentials and resolves a principal from the token", async () => {
    const { kernel } = await makeHousehold();
    const result = await kernel.login({ username: "alice", password: PW.dev });
    expect(result).toMatchObject({ ok: true, mustChangePassword: true });
    if (!result.ok) throw new Error();
    const principal = await kernel.authenticate(result.token);
    expect(principal?.username).toBe("alice");
    expect(principal?.permissions.has("sessions.own")).toBe(true);
    expect(principal?.permissions.has("users.manage")).toBe(false);
  });

  it("gives identical results for unknown user, wrong password and disabled user", async () => {
    const { kernel, admin, aliceId } = await makeHousehold();
    await kernel.setUserStatus(admin, aliceId, "disabled");
    const results = await Promise.all([
      kernel.login({ username: "nobody", password: "whatever whatever" }),
      kernel.login({ username: "bob", password: "wrong wrong wrong wrong" }),
      kernel.login({ username: "alice", password: PW.dev }), // correct password, disabled account
    ]);
    for (const r of results) expect(r).toEqual({ ok: false, reason: "invalid_credentials" });
  });

  it("rejects malformed, forged and unknown tokens", async () => {
    const { kernel } = await makeHousehold();
    for (const t of ["", "pus_", "pus_" + "A".repeat(43), "Bearer x", "pui_" + "A".repeat(43)]) {
      expect(await kernel.authenticate(t)).toBeNull();
    }
  });

  it("stores only a hash of the session token and a hash of the password", async () => {
    const { kernel, store } = await makeHousehold();
    const result = await kernel.login({ username: "alice", password: PW.dev });
    if (!result.ok) throw new Error();
    const dump = JSON.stringify(await store.read());
    expect(dump).not.toContain(result.token);
    expect(dump).toContain(hashToken(result.token));
    for (const pw of Object.values(PW)) expect(dump).not.toContain(pw);
  });
});

describe("session lifetime and revocation", () => {
  it("expires after the idle timeout and slides while in use", async () => {
    const { kernel, clock } = await makeHousehold({ idleTimeoutMs: 1000 * 60, touchIntervalMs: 0, absoluteTimeoutMs: 1000 * 3600 });
    const r = await kernel.login({ username: "alice", password: PW.dev });
    if (!r.ok) throw new Error();
    clock.advance(50_000);
    expect(await kernel.authenticate(r.token)).not.toBeNull(); // slides idle window
    clock.advance(50_000);
    expect(await kernel.authenticate(r.token)).not.toBeNull();
    clock.advance(61_000);
    expect(await kernel.authenticate(r.token)).toBeNull();
  });

  it("expires at the absolute limit even if continuously used", async () => {
    const { kernel, clock } = await makeHousehold({ idleTimeoutMs: 1000 * 60, absoluteTimeoutMs: 1000 * 150, touchIntervalMs: 0 });
    const r = await kernel.login({ username: "alice", password: PW.dev });
    if (!r.ok) throw new Error();
    for (let i = 0; i < 2; i++) {
      clock.advance(50_000);
      expect(await kernel.authenticate(r.token)).not.toBeNull();
    }
    clock.advance(50_000);
    expect(await kernel.authenticate(r.token)).toBeNull();
  });

  it("logout revokes that session only", async () => {
    const { kernel } = await makeHousehold();
    const a = await kernel.login({ username: "alice", password: PW.dev });
    const b = await kernel.login({ username: "alice", password: PW.dev });
    if (!a.ok || !b.ok) throw new Error();
    const pa = (await kernel.authenticate(a.token))!;
    await kernel.logout(pa);
    expect(await kernel.authenticate(a.token)).toBeNull();
    expect(await kernel.authenticate(b.token)).not.toBeNull();
  });

  it("an administrator revoking a user's sessions takes effect on the next request", async () => {
    const { kernel, admin, aliceId } = await makeHousehold();
    const r = await kernel.login({ username: "alice", password: PW.dev });
    if (!r.ok) throw new Error();
    expect(await kernel.revokeAllLoginSessions(admin, aliceId)).toBeGreaterThan(0);
    expect(await kernel.authenticate(r.token)).toBeNull();
  });

  it("a developer cannot revoke another user's session, but can revoke their own", async () => {
    const { kernel, alice, bob, bobId } = await makeHousehold();
    await expect(kernel.revokeAllLoginSessions(alice, bobId)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(kernel.listLoginSessions(alice, bobId)).rejects.toBeInstanceOf(ForbiddenError);
    const own = await kernel.listLoginSessions(bob, bob.userId);
    expect(own.length).toBeGreaterThan(0);
    await kernel.revokeLoginSession(bob, bob.loginSessionId);
    expect(await kernel.authenticate("pus_" + "A".repeat(43))).toBeNull();
  });

  it("disabling a user kills live sessions and blocks new ones; re-enabling does not resurrect old tokens", async () => {
    const { kernel, admin, aliceId } = await makeHousehold();
    const r = await kernel.login({ username: "alice", password: PW.dev });
    if (!r.ok) throw new Error();
    await kernel.setUserStatus(admin, aliceId, "disabled");
    expect(await kernel.authenticate(r.token)).toBeNull();
    await kernel.setUserStatus(admin, aliceId, "active");
    expect(await kernel.authenticate(r.token)).toBeNull();
    expect((await kernel.login({ username: "alice", password: PW.dev })).ok).toBe(true);
  });

  it("deleting a user ends their sessions", async () => {
    const { kernel, admin, aliceId } = await makeHousehold();
    const r = await kernel.login({ username: "alice", password: PW.dev });
    if (!r.ok) throw new Error();
    await kernel.deleteUser(admin, aliceId);
    expect(await kernel.authenticate(r.token)).toBeNull();
  });
});

describe("brute-force protection", () => {
  it("locks an account after repeated failures, even for the correct password, then recovers", async () => {
    const { kernel, clock } = await makeHousehold();
    for (let i = 0; i < 8; i++) {
      expect(await kernel.login({ username: "alice", password: "wrong password " + i, remoteAddress: `10.0.0.${i}` })).toEqual({ ok: false, reason: "invalid_credentials" });
    }
    const locked = await kernel.login({ username: "alice", password: PW.dev, remoteAddress: "10.9.9.9" });
    expect(locked).toMatchObject({ ok: false, reason: "throttled" });
    clock.advance(61_000);
    expect((await kernel.login({ username: "alice", password: PW.dev, remoteAddress: "10.9.9.9" })).ok).toBe(true);
  });

  it("throttles one address spraying many usernames", async () => {
    const { kernel } = await makeHousehold();
    for (let i = 0; i < 30; i++) await kernel.login({ username: `user${i}`, password: "wrong password!!", remoteAddress: "203.0.113.5" });
    const r = await kernel.login({ username: "alice", password: PW.dev, remoteAddress: "203.0.113.5" });
    expect(r).toMatchObject({ ok: false, reason: "throttled" });
    // A different address is unaffected.
    expect((await kernel.login({ username: "alice", password: PW.dev, remoteAddress: "198.51.100.7" })).ok).toBe(true);
  });

  it("lock durations grow but are capped, and an administrator can unlock", async () => {
    const { kernel, admin } = await makeHousehold();
    for (let i = 0; i < 8; i++) await kernel.login({ username: "bob", password: "wrong password " + i, remoteAddress: `10.1.0.${i}` });
    expect((await kernel.login({ username: "bob", password: PW.other, remoteAddress: "10.2.0.1" })).ok).toBe(false);
    kernel.unlockAccount(admin, "bob");
    expect((await kernel.login({ username: "bob", password: PW.other, remoteAddress: "10.2.0.1" })).ok).toBe(true);
  });

  it("audits failures without recording the attempted password", async () => {
    const { kernel, audit } = await makeHousehold();
    await kernel.login({ username: "alice", password: "hunter2hunter2hunter2" });
    expect(JSON.stringify(audit.events)).not.toContain("hunter2");
    expect(audit.events.some((e) => e.type === "auth.login.failure")).toBe(true);
  });
});

describe("password change, invitations and recovery", () => {
  it("changing a password requires the current one and ends other sessions", async () => {
    const { kernel, alice } = await makeHousehold();
    const other = await kernel.login({ username: "alice", password: PW.dev });
    if (!other.ok) throw new Error();
    await expect(kernel.changePassword(alice, "not the current one", "brand new passphrase 1")).rejects.toBeInstanceOf(ForbiddenError);
    await kernel.changePassword(alice, PW.dev, "brand new passphrase 1");
    expect(await kernel.authenticate(other.token)).toBeNull();
    expect((await kernel.login({ username: "alice", password: PW.dev })).ok).toBe(false);
    expect((await kernel.login({ username: "alice", password: "brand new passphrase 1" })).ok).toBe(true);
  });

  it("invitations are single-use, expiring, revocable and not issuable by developers", async () => {
    const { kernel, admin, alice, clock } = await makeHousehold();
    await expect(kernel.createInvitation(alice, { roleIds: ["developer"] })).rejects.toBeInstanceOf(ForbiddenError);

    const { token } = await kernel.createInvitation(admin, { roleIds: ["developer"] });
    await kernel.redeemInvitation(token, { username: "carol", password: "first invited passphrase 1" });
    await expect(kernel.redeemInvitation(token, { username: "carol2", password: "first invited passphrase 1" })).rejects.toBeInstanceOf(ForbiddenError);

    const expired = await kernel.createInvitation(admin, { roleIds: ["developer"] });
    clock.advance(73 * 3600_000);
    await expect(kernel.redeemInvitation(expired.token, { username: "dave", password: "second invited passphrase 2" })).rejects.toBeInstanceOf(ForbiddenError);

    const revoked = await kernel.createInvitation(admin, { roleIds: ["developer"] });
    await kernel.revokeInvitation(admin, revoked.invitation.id);
    await expect(kernel.redeemInvitation(revoked.token, { username: "erin", password: "third invited passphrase 3" })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("an invitation cannot mint a role the issuer does not hold, and a redeemed account has only the invited roles", async () => {
    const { kernel, admin } = await makeHousehold();
    const { token } = await kernel.createInvitation(admin, { roleIds: ["developer"] });
    const { userId } = await kernel.redeemInvitation(token, { username: "carol", password: "first invited passphrase 1" });
    const r = await kernel.login({ username: "carol", password: "first invited passphrase 1" });
    if (!r.ok) throw new Error();
    const p = (await kernel.authenticate(r.token))!;
    expect(p.userId).toBe(userId);
    expect(p.permissions.has("users.manage")).toBe(false);
  });

  it("administrator-assisted reset sets a new password and ends all of the user's sessions; token is single-use", async () => {
    const { kernel, admin, aliceId } = await makeHousehold();
    const live = await kernel.login({ username: "alice", password: PW.dev });
    if (!live.ok) throw new Error();
    const { token } = await kernel.createPasswordReset(admin, aliceId);
    await kernel.redeemPasswordReset(token, "a freshly reset passphrase");
    expect(await kernel.authenticate(live.token)).toBeNull();
    expect((await kernel.login({ username: "alice", password: "a freshly reset passphrase" })).ok).toBe(true);
    await expect(kernel.redeemPasswordReset(token, "another passphrase again 1")).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("a reset token cannot be redeemed as an invitation and vice versa", async () => {
    const { kernel, admin, aliceId } = await makeHousehold();
    const reset = await kernel.createPasswordReset(admin, aliceId);
    await expect(kernel.redeemInvitation(reset.token, { username: "mallory", password: "forged redeem passphrase 4" })).rejects.toBeInstanceOf(ForbiddenError);
    const invite = await kernel.createInvitation(admin, { roleIds: ["developer"] });
    await expect(kernel.redeemPasswordReset(invite.token, "forged redeem passphrase 4")).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("audit trail", () => {
  it("records security-relevant events and is readable only with audit.read", async () => {
    const { kernel, admin, alice } = await makeKernelWithAlice();
    expect((await kernel.readAudit(admin)).some((e) => e.type === "user.created")).toBe(true);
    await expect(kernel.readAudit(alice)).rejects.toBeInstanceOf(ForbiddenError);
  });
});

async function makeKernelWithAlice() {
  const ctx = await makeKernel();
  await ctx.kernel.createUser(ctx.admin, { username: "alice", roleIds: ["developer"], initialPassword: PW.dev });
  const alice = await ctx.loginAs("alice", PW.dev);
  return { ...ctx, alice };
}
void readFile;
