import { timingSafeEqual } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  USERNAME_PATTERN,
  type AllowanceKind,
  type Invitation,
  type LoginSession,
  type Project,
  type ProjectAccess,
  type StoreData,
  type User,
} from "../../shared/model.js";
import { assertPasswordAcceptable, type PasswordHasher } from "./password.js";
import type { AuditLog } from "./audit.js";
import {
  authorizeAgentSession,
  authorizeProject,
  authorizeRoleAssignment,
  has,
  isAllowanceGranted,
  permissionsForRoles,
  type Decision,
  type Principal,
} from "./authz.js";
import { addMs, type Clock } from "./clock.js";
import { FailureThrottle, DEFAULT_ACCOUNT_POLICY, DEFAULT_ADDRESS_POLICY, type RateLimitPolicy } from "./rate-limit.js";
import type { Store } from "./json-store.js";
import { generateId, generateToken, hashToken, looksLikeToken } from "./tokens.js";

export class ForbiddenError extends Error {
  constructor(public readonly reason: string) {
    super(`forbidden: ${reason}`);
    this.name = "ForbiddenError";
  }
}
export class NotFoundError extends Error {
  constructor(what: string) {
    super(`not found: ${what}`);
    this.name = "NotFoundError";
  }
}
export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConflictError";
  }
}

export interface KernelConfig {
  idleTimeoutMs: number;
  absoluteTimeoutMs: number;
  /** Minimum interval between persisted `lastSeenAt` updates, to avoid a write per request. */
  touchIntervalMs: number;
  invitationTtlMs: number;
  accountThrottle: RateLimitPolicy;
  addressThrottle: RateLimitPolicy;
}

export const DEFAULT_KERNEL_CONFIG: KernelConfig = {
  idleTimeoutMs: 30 * 24 * 3600_000,
  absoluteTimeoutMs: 90 * 24 * 3600_000,
  touchIntervalMs: 60_000,
  invitationTtlMs: 72 * 3600_000,
  accountThrottle: DEFAULT_ACCOUNT_POLICY,
  addressThrottle: DEFAULT_ADDRESS_POLICY,
};

export interface KernelDeps {
  store: Store;
  hasher: PasswordHasher;
  audit: AuditLog;
  clock: Clock;
  config?: Partial<KernelConfig>;
}

export type LoginResult =
  | { ok: true; token: string; sessionId: string; userId: string; mustChangePassword: boolean }
  | { ok: false; reason: "invalid_credentials" }
  | { ok: false; reason: "throttled"; retryAfterMs: number };

export interface LoginInput {
  username: string;
  password: string;
  remoteAddress?: string | null;
  deviceId?: string | null;
  deviceLabel?: string | null;
}

const BOOTSTRAP_FILE = "bootstrap-token";

export function normalizeUsername(username: string): string {
  return username.trim().toLowerCase();
}

/**
 * The identity and authorization kernel. It has no dependency on Paseo: it answers "who is this
 * and what may they do" and persists the answer. Wiring it into the daemon's admission path is
 * a separate layer (see docs/05-core-extension-requirements.md); until that exists this class
 * is NOT an access boundary for a running daemon.
 */
export class UsersKernel {
  private readonly store: Store;
  private readonly hasher: PasswordHasher;
  private readonly audit: AuditLog;
  private readonly clock: Clock;
  private readonly config: KernelConfig;
  private readonly accountThrottle: FailureThrottle;
  private readonly addressThrottle: FailureThrottle;
  private readonly lastTouch = new Map<string, number>();
  /** Verified against when the account does not exist, so response time does not reveal usernames. */
  private dummyHash: Promise<string> | null = null;

  constructor(deps: KernelDeps) {
    this.store = deps.store;
    this.hasher = deps.hasher;
    this.audit = deps.audit;
    this.clock = deps.clock;
    this.config = { ...DEFAULT_KERNEL_CONFIG, ...deps.config };
    this.accountThrottle = new FailureThrottle(this.config.accountThrottle, deps.clock);
    this.addressThrottle = new FailureThrottle(this.config.addressThrottle, deps.clock);
  }

  // ---------------------------------------------------------------- first run

  async isInitialized(): Promise<boolean> {
    return (await this.store.read()).initialized;
  }

  /**
   * First-run: write a single-use bootstrap token to `dir` (mode 0600). Whoever can read that
   * file already controls the daemon's home directory, which is the same trust the daemon's
   * own `local-credential` file relies on. Returns null when already initialized.
   */
  async issueBootstrapToken(dir: string): Promise<string | null> {
    if (await this.isInitialized()) return null;
    const token = generateToken("invitation");
    await writeFile(join(dir, BOOTSTRAP_FILE), `${token}\n`, { mode: 0o600 });
    return token;
  }

  /** Creates the first administrator. Fails if any user exists or the bootstrap token is wrong. */
  async initialize(
    dir: string,
    input: { bootstrapToken: string; username: string; password: string; displayName?: string },
  ): Promise<{ userId: string }> {
    const path = join(dir, BOOTSTRAP_FILE);
    let expected: string;
    try {
      expected = (await readFile(path, "utf8")).trim();
    } catch {
      throw new ForbiddenError("instance cannot be initialized");
    }
    const a = Buffer.from(input.bootstrapToken);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new ForbiddenError("instance cannot be initialized");

    const username = normalizeUsername(input.username);
    this.assertUsername(username);
    assertPasswordAcceptable(input.password, { username });
    const passwordHash = await this.hasher.hash(input.password);
    const now = this.clock.now().toISOString();
    const userId = generateId();

    await this.store.transact((data) => {
      if (data.initialized || data.users.length > 0) throw new ForbiddenError("instance cannot be initialized");
      data.users.push({
        id: userId,
        username,
        displayName: input.displayName ?? username,
        roleIds: ["administrator"],
        status: "active",
        passwordHash,
        mustChangePassword: false,
        passwordChangedAt: now,
        createdAt: now,
        createdBy: null,
        disabledAt: null,
        unixAccount: null,
      });
      data.initialized = true;
    });
    await rm(path, { force: true });
    await this.audit.record("instance.initialized", { actorId: userId, targetId: userId });
    return { userId };
  }

  // ----------------------------------------------------------------- login

  async login(input: LoginInput): Promise<LoginResult> {
    const username = normalizeUsername(input.username);
    const address = input.remoteAddress ?? "unknown";
    const accountKey = `u:${username}`;
    const addressKey = `a:${address}`;

    const wait = Math.max(this.accountThrottle.retryAfterMs(accountKey), this.addressThrottle.retryAfterMs(addressKey));
    if (wait > 0) {
      await this.audit.record("auth.login.throttled", { detail: { username: username.slice(0, 32), address } });
      return { ok: false, reason: "throttled", retryAfterMs: wait };
    }

    const data = await this.store.read();
    const user = data.users.find((u) => u.username === username);
    // Always spend one hash verification so unknown, disabled and wrong-password look alike.
    const hashToCheck = user?.passwordHash ?? (await this.getDummyHash());
    const passwordOk = await this.hasher.verify(input.password, hashToCheck);

    if (!user || !passwordOk || user.status !== "active" || !user.passwordHash) {
      this.accountThrottle.recordFailure(accountKey);
      this.addressThrottle.recordFailure(addressKey);
      await this.audit.record("auth.login.failure", {
        targetId: user?.id ?? null,
        detail: { address, cause: !user ? "unknown_user" : user.status !== "active" ? "disabled" : "bad_password" },
      });
      return { ok: false, reason: "invalid_credentials" };
    }

    this.accountThrottle.recordSuccess(accountKey);
    const token = generateToken("session");
    const now = this.clock.now();
    const session: LoginSession = {
      id: generateId(),
      userId: user.id,
      tokenHash: hashToken(token),
      deviceId: input.deviceId ?? null,
      deviceLabel: input.deviceLabel ?? null,
      createdAt: now.toISOString(),
      lastSeenAt: now.toISOString(),
      idleExpiresAt: addMs(now, this.config.idleTimeoutMs).toISOString(),
      absoluteExpiresAt: addMs(now, this.config.absoluteTimeoutMs).toISOString(),
      revokedAt: null,
      revokedReason: null,
      remoteAddress: input.remoteAddress ?? null,
    };
    const rehash = this.hasher.needsRehash(user.passwordHash) ? await this.hasher.hash(input.password) : null;
    await this.store.transact((draft) => {
      draft.sessions.push(session);
      if (rehash) {
        const target = draft.users.find((u) => u.id === user.id);
        if (target) target.passwordHash = rehash;
      }
    });
    await this.audit.record("auth.login.success", { actorId: user.id, detail: { sessionId: session.id, address } });
    return { ok: true, token, sessionId: session.id, userId: user.id, mustChangePassword: user.mustChangePassword };
  }

  /** Resolves a bearer token to a principal, or null. Never throws for bad input. */
  async authenticate(token: string): Promise<Principal | null> {
    if (!looksLikeToken("session", token)) return null;
    const hash = hashToken(token);
    const data = await this.store.read();
    const session = data.sessions.find((s) => s.tokenHash === hash);
    if (!session || session.revokedAt) return null;
    const now = this.clock.now();
    if (now >= new Date(session.idleExpiresAt) || now >= new Date(session.absoluteExpiresAt)) return null;
    const user = data.users.find((u) => u.id === session.userId);
    if (!user || user.status !== "active") return null;

    const last = this.lastTouch.get(session.id) ?? new Date(session.lastSeenAt).getTime();
    if (now.getTime() - last >= this.config.touchIntervalMs) {
      this.lastTouch.set(session.id, now.getTime());
      await this.store.transact((draft) => {
        const target = draft.sessions.find((s) => s.id === session.id);
        if (target && !target.revokedAt) {
          target.lastSeenAt = now.toISOString();
          const idle = addMs(now, this.config.idleTimeoutMs);
          const cap = new Date(target.absoluteExpiresAt);
          target.idleExpiresAt = (idle < cap ? idle : cap).toISOString();
        }
      });
    }
    return {
      userId: user.id,
      username: user.username,
      roleIds: [...user.roleIds],
      permissions: permissionsForRoles(data, user.roleIds),
      loginSessionId: session.id,
    };
  }

  async logout(principal: Principal): Promise<void> {
    await this.revokeSessions((s) => s.id === principal.loginSessionId, "logout", principal.userId);
    await this.audit.record("auth.logout", { actorId: principal.userId });
  }

  async listLoginSessions(actor: Principal, userId: string): Promise<LoginSession[]> {
    this.requireSelfOr(actor, userId, "sessions.revoke_any");
    const data = await this.store.read();
    return data.sessions.filter((s) => s.userId === userId && !s.revokedAt);
  }

  async revokeLoginSession(actor: Principal, loginSessionId: string): Promise<void> {
    const data = await this.store.read();
    const target = data.sessions.find((s) => s.id === loginSessionId);
    if (!target) throw new NotFoundError("login session");
    this.requireSelfOr(actor, target.userId, "sessions.revoke_any");
    await this.revokeSessions((s) => s.id === loginSessionId, "revoked", actor.userId);
  }

  async revokeAllLoginSessions(actor: Principal, userId: string, exceptCurrent = false): Promise<number> {
    this.requireSelfOr(actor, userId, "sessions.revoke_any");
    return this.revokeSessions(
      (s) => s.userId === userId && !(exceptCurrent && s.id === actor.loginSessionId),
      "revoked_all",
      actor.userId,
    );
  }

  // -------------------------------------------------------------- passwords

  async changePassword(actor: Principal, current: string, next: string): Promise<void> {
    const data = await this.store.read();
    const user = data.users.find((u) => u.id === actor.userId);
    if (!user?.passwordHash || !(await this.hasher.verify(current, user.passwordHash))) {
      throw new ForbiddenError("current password incorrect");
    }
    assertPasswordAcceptable(next, { username: user.username });
    const hash = await this.hasher.hash(next);
    await this.store.transact((draft) => {
      const target = draft.users.find((u) => u.id === user.id);
      if (!target) return;
      target.passwordHash = hash;
      target.mustChangePassword = false;
      target.passwordChangedAt = this.clock.now().toISOString();
    });
    // A changed password ends every other login, which is what a person expects after a suspected leak.
    await this.revokeSessions((s) => s.userId === user.id && s.id !== actor.loginSessionId, "password_changed", user.id);
    await this.audit.record("auth.password.changed", { actorId: user.id, targetId: user.id });
  }

  // ---------------------------------------------------------- invitations

  /** Administrator-issued, single-use, expiring. The raw token is returned once and never stored. */
  async createInvitation(actor: Principal, input: { roleIds: string[] }): Promise<{ token: string; invitation: Invitation }> {
    this.require(actor, "users.manage");
    const token = generateToken("invitation");
    const now = this.clock.now();
    const invitation: Invitation = {
      id: generateId(),
      kind: "invite",
      tokenHash: hashToken(token),
      roleIds: input.roleIds,
      targetUserId: null,
      createdBy: actor.userId,
      createdAt: now.toISOString(),
      expiresAt: addMs(now, this.config.invitationTtlMs).toISOString(),
      usedAt: null,
      usedBy: null,
      revokedAt: null,
    };
    await this.store.transact((data) => {
      this.assertAssignable(data, actor, input.roleIds);
      data.invitations.push(invitation);
    });
    await this.audit.record("invitation.created", { actorId: actor.userId, targetId: invitation.id, detail: { kind: "invite" } });
    return { token, invitation };
  }

  /** Administrator-assisted recovery: a one-time reset token for an existing account. */
  async createPasswordReset(actor: Principal, userId: string): Promise<{ token: string; invitation: Invitation }> {
    this.require(actor, "users.manage");
    const token = generateToken("invitation");
    const now = this.clock.now();
    const invitation: Invitation = {
      id: generateId(),
      kind: "reset",
      tokenHash: hashToken(token),
      roleIds: [],
      targetUserId: userId,
      createdBy: actor.userId,
      createdAt: now.toISOString(),
      expiresAt: addMs(now, this.config.invitationTtlMs).toISOString(),
      usedAt: null,
      usedBy: null,
      revokedAt: null,
    };
    await this.store.transact((data) => {
      const target = data.users.find((u) => u.id === userId);
      if (!target) throw new NotFoundError("user");
      // Resetting an account that holds permissions the actor lacks would be a takeover path.
      this.assertCanAdminister(data, actor, target);
      data.invitations.push(invitation);
    });
    await this.audit.record("auth.password.reset_issued", { actorId: actor.userId, targetId: userId });
    return { token, invitation };
  }

  async revokeInvitation(actor: Principal, invitationId: string): Promise<void> {
    this.require(actor, "users.manage");
    await this.store.transact((data) => {
      const inv = data.invitations.find((i) => i.id === invitationId);
      if (!inv) throw new NotFoundError("invitation");
      inv.revokedAt = this.clock.now().toISOString();
    });
    await this.audit.record("invitation.revoked", { actorId: actor.userId, targetId: invitationId });
  }

  /** Redeems an `invite` token to create an account. Unauthenticated entry point. */
  async redeemInvitation(
    token: string,
    input: { username: string; password: string; displayName?: string },
  ): Promise<{ userId: string }> {
    const username = normalizeUsername(input.username);
    this.assertUsername(username);
    assertPasswordAcceptable(input.password, { username });
    const passwordHash = await this.hasher.hash(input.password);
    const userId = generateId();
    const now = this.clock.now();
    const nowIso = now.toISOString();
    await this.store.transact((data) => {
      const inv = this.usableInvitation(data, token, "invite", now);
      if (data.users.some((u) => u.username === username)) throw new ConflictError("username unavailable");
      data.users.push({
        id: userId,
        username,
        displayName: input.displayName ?? username,
        roleIds: [...inv.roleIds],
        status: "active",
        passwordHash,
        mustChangePassword: false,
        passwordChangedAt: nowIso,
        createdAt: nowIso,
        createdBy: inv.createdBy,
        disabledAt: null,
        unixAccount: null,
      });
      inv.usedAt = nowIso;
      inv.usedBy = userId;
    });
    await this.audit.record("invitation.used", { actorId: userId, detail: { kind: "invite" } });
    await this.audit.record("user.created", { actorId: userId, targetId: userId, detail: { via: "invitation" } });
    return { userId };
  }

  /** Redeems a `reset` token: sets a new password and ends every existing login for the account. */
  async redeemPasswordReset(token: string, newPassword: string): Promise<void> {
    const now = this.clock.now();
    let username = "";
    const pending = (await this.store.read()).invitations.find((i) => i.tokenHash === hashToken(token));
    if (pending?.targetUserId) {
      username = (await this.store.read()).users.find((u) => u.id === pending.targetUserId)?.username ?? "";
    }
    assertPasswordAcceptable(newPassword, { username });
    const passwordHash = await this.hasher.hash(newPassword);
    let userId = "";
    await this.store.transact((data) => {
      const inv = this.usableInvitation(data, token, "reset", now);
      const user = data.users.find((u) => u.id === inv.targetUserId);
      if (!user) throw new NotFoundError("user");
      user.passwordHash = passwordHash;
      user.mustChangePassword = false;
      user.passwordChangedAt = now.toISOString();
      inv.usedAt = now.toISOString();
      inv.usedBy = user.id;
      userId = user.id;
    });
    await this.revokeSessions((s) => s.userId === userId, "password_reset", userId);
    await this.audit.record("auth.password.reset_used", { actorId: userId, targetId: userId });
  }

  // ------------------------------------------------------ user administration

  async createUser(
    actor: Principal,
    input: { username: string; displayName?: string; roleIds: string[]; initialPassword: string },
  ): Promise<{ userId: string }> {
    this.require(actor, "users.manage");
    const username = normalizeUsername(input.username);
    this.assertUsername(username);
    assertPasswordAcceptable(input.initialPassword, { username });
    const passwordHash = await this.hasher.hash(input.initialPassword);
    const userId = generateId();
    const nowIso = this.clock.now().toISOString();
    await this.store.transact((data) => {
      this.assertAssignable(data, actor, input.roleIds);
      if (data.users.some((u) => u.username === username)) throw new ConflictError("username unavailable");
      data.users.push({
        id: userId,
        username,
        displayName: input.displayName ?? username,
        roleIds: [...input.roleIds],
        status: "active",
        passwordHash,
        mustChangePassword: true,
        passwordChangedAt: null,
        createdAt: nowIso,
        createdBy: actor.userId,
        disabledAt: null,
        unixAccount: null,
      });
    });
    await this.audit.record("user.created", { actorId: actor.userId, targetId: userId, detail: { via: "admin" } });
    return { userId };
  }

  async setUserRoles(actor: Principal, userId: string, roleIds: string[]): Promise<void> {
    await this.store.transact((data) => {
      const verdict = authorizeRoleAssignment(data, actor, userId, roleIds);
      if (!verdict.allow) throw new ForbiddenError(verdict.reason);
      const user = data.users.find((u) => u.id === userId);
      if (!user) throw new NotFoundError("user");
      this.assertCanAdminister(data, actor, user);
      user.roleIds = [...roleIds];
      this.assertAdministratorRemains(data);
    });
    // Permissions are resolved per request from the user's roles, but sessions of a demoted user are dropped as defense in depth.
    await this.revokeSessions((s) => s.userId === userId, "roles_changed", actor.userId);
    await this.audit.record("user.roles.changed", { actorId: actor.userId, targetId: userId, detail: { roles: roleIds.join(",") } });
  }

  async setUserStatus(actor: Principal, userId: string, status: "active" | "disabled"): Promise<void> {
    this.require(actor, "users.manage");
    if (userId === actor.userId && status === "disabled") throw new ForbiddenError("cannot disable yourself");
    await this.store.transact((data) => {
      const user = data.users.find((u) => u.id === userId);
      if (!user) throw new NotFoundError("user");
      this.assertCanAdminister(data, actor, user);
      user.status = status;
      user.disabledAt = status === "disabled" ? this.clock.now().toISOString() : null;
      this.assertAdministratorRemains(data);
    });
    if (status === "disabled") await this.revokeSessions((s) => s.userId === userId, "user_disabled", actor.userId);
    await this.audit.record(status === "disabled" ? "user.disabled" : "user.enabled", { actorId: actor.userId, targetId: userId });
  }

  async deleteUser(actor: Principal, userId: string): Promise<void> {
    this.require(actor, "users.manage");
    if (userId === actor.userId) throw new ForbiddenError("cannot delete yourself");
    await this.store.transact((data) => {
      const user = data.users.find((u) => u.id === userId);
      if (!user) throw new NotFoundError("user");
      this.assertCanAdminister(data, actor, user);
      data.users = data.users.filter((u) => u.id !== userId);
      data.sessions = data.sessions.filter((s) => s.userId !== userId);
      data.allowances = data.allowances.filter((a) => a.userId !== userId);
      data.externalIdentities = data.externalIdentities.filter((e) => e.userId !== userId);
      data.sessionOwnership = data.sessionOwnership.filter((o) => o.ownerId !== userId);
      for (const project of data.projects) {
        project.members = project.members.filter((m) => m.userId !== userId);
        // Orphaned personal projects become administrator-owned rather than disappearing.
        if (project.ownerId === userId) project.ownerId = null;
      }
      this.assertAdministratorRemains(data);
    });
    await this.audit.record("user.deleted", { actorId: actor.userId, targetId: userId });
  }

  async listUsers(actor: Principal): Promise<Array<Omit<User, "passwordHash">>> {
    this.require(actor, "users.manage");
    const data = await this.store.read();
    return data.users.map(({ passwordHash: _hash, ...rest }) => rest);
  }

  // ----------------------------------------------------------------- projects

  async createProject(actor: Principal, input: { paseoRef: string; name: string; administratorOwned?: boolean }): Promise<Project> {
    this.require(actor, "projects.create");
    const ownerId = input.administratorOwned ? this.requireReturning(actor, "projects.manage_any", null) : actor.userId;
    const project: Project = {
      id: generateId(),
      paseoRef: input.paseoRef,
      name: input.name,
      ownerId,
      members: [],
      createdAt: this.clock.now().toISOString(),
    };
    await this.store.transact((data) => {
      if (data.projects.some((p) => p.paseoRef === input.paseoRef)) throw new ConflictError("project already registered");
      data.projects.push(project);
    });
    await this.audit.record("project.created", { actorId: actor.userId, targetId: project.id });
    return project;
  }

  /** Projects the caller may at least read. Hidden projects are absent, not "forbidden". */
  async listProjects(actor: Principal): Promise<Project[]> {
    const data = await this.store.read();
    return data.projects.filter((p) => authorizeProject(actor, p, "read").allow);
  }

  async shareProject(actor: Principal, projectId: string, userId: string, access: ProjectAccess): Promise<void> {
    await this.store.transact((data) => {
      const project = this.findProject(data, actor, projectId);
      const verdict = authorizeProject(actor, project, "share");
      if (!verdict.allow) throw new ForbiddenError(verdict.reason);
      if (!data.users.some((u) => u.id === userId && u.status === "active")) throw new NotFoundError("user");
      if (userId === project.ownerId) throw new ConflictError("owner already has full access");
      project.members = project.members.filter((m) => m.userId !== userId);
      project.members.push({ userId, access, grantedBy: actor.userId, grantedAt: this.clock.now().toISOString() });
    });
    await this.audit.record("project.shared", { actorId: actor.userId, targetId: projectId, detail: { with: userId, access } });
  }

  async unshareProject(actor: Principal, projectId: string, userId: string): Promise<void> {
    await this.store.transact((data) => {
      const project = this.findProject(data, actor, projectId);
      const verdict = authorizeProject(actor, project, "share");
      if (!verdict.allow) throw new ForbiddenError(verdict.reason);
      project.members = project.members.filter((m) => m.userId !== userId);
    });
    await this.audit.record("project.unshared", { actorId: actor.userId, targetId: projectId, detail: { with: userId } });
  }

  async deleteProject(actor: Principal, projectId: string): Promise<void> {
    await this.store.transact((data) => {
      const project = this.findProject(data, actor, projectId);
      const verdict = authorizeProject(actor, project, "delete");
      if (!verdict.allow) throw new ForbiddenError(verdict.reason);
      data.projects = data.projects.filter((p) => p.id !== projectId);
      data.sessionOwnership = data.sessionOwnership.filter((o) => o.projectId !== projectId);
    });
    await this.audit.record("project.deleted", { actorId: actor.userId, targetId: projectId });
  }

  // ---------------------------------------------------------- coding sessions

  /** Records ownership of a new coding session. The caller must be able to write the project. */
  async registerAgentSession(actor: Principal, input: { paseoAgentId: string; projectId: string | null }): Promise<void> {
    this.require(actor, "sessions.own");
    await this.store.transact((data) => {
      if (input.projectId) {
        const project = this.findProject(data, actor, input.projectId);
        const verdict = authorizeProject(actor, project, "write");
        if (!verdict.allow) throw new ForbiddenError(verdict.reason);
      }
      if (data.sessionOwnership.some((o) => o.paseoAgentId === input.paseoAgentId)) {
        throw new ConflictError("session already registered");
      }
      data.sessionOwnership.push({
        paseoAgentId: input.paseoAgentId,
        ownerId: actor.userId,
        projectId: input.projectId,
        createdAt: this.clock.now().toISOString(),
      });
    });
  }

  async authorizeAgentSession(actor: Principal, paseoAgentId: string, action: "read" | "write"): Promise<Decision> {
    const data = await this.store.read();
    const ownership = data.sessionOwnership.find((o) => o.paseoAgentId === paseoAgentId);
    const project = ownership?.projectId ? data.projects.find((p) => p.id === ownership.projectId) : undefined;
    const verdict = authorizeAgentSession(actor, ownership, project, action);
    if (!verdict.allow) {
      await this.audit.record("authz.denied", { actorId: actor.userId, targetId: paseoAgentId, detail: { action, reason: verdict.reason } });
    } else if (verdict.adminOverride) {
      await this.audit.record("authz.admin_override", { actorId: actor.userId, targetId: paseoAgentId, detail: { action } });
    }
    return verdict;
  }

  /** Session ids the caller may read. This is what a per-user agent list must be filtered by. */
  async listVisibleAgentSessions(actor: Principal): Promise<string[]> {
    const data = await this.store.read();
    return data.sessionOwnership
      .filter((o) => {
        const project = o.projectId ? data.projects.find((p) => p.id === o.projectId) : undefined;
        const verdict = authorizeAgentSession(actor, o, project, "read");
        return verdict.allow && !verdict.adminOverride;
      })
      .map((o) => o.paseoAgentId);
  }

  // --------------------------------------------------------------- allowances

  async grantAllowance(actor: Principal, userId: string, kind: AllowanceKind, ref: string): Promise<void> {
    this.require(actor, "policy.manage");
    await this.store.transact((data) => {
      if (!data.users.some((u) => u.id === userId)) throw new NotFoundError("user");
      if (!isAllowanceGranted(data, userId, kind, ref)) {
        data.allowances.push({ userId, kind, ref, grantedBy: actor.userId, grantedAt: this.clock.now().toISOString() });
      }
    });
    await this.audit.record("allowance.granted", { actorId: actor.userId, targetId: userId, detail: { kind, ref } });
  }

  async revokeAllowance(actor: Principal, userId: string, kind: AllowanceKind, ref: string): Promise<void> {
    this.require(actor, "policy.manage");
    await this.store.transact((data) => {
      data.allowances = data.allowances.filter((a) => !(a.userId === userId && a.kind === kind && a.ref === ref));
    });
    await this.audit.record("allowance.revoked", { actorId: actor.userId, targetId: userId, detail: { kind, ref } });
  }

  async allowancesFor(actor: Principal, userId: string): Promise<Array<{ kind: AllowanceKind; ref: string }>> {
    this.requireSelfOr(actor, userId, "policy.manage");
    const data = await this.store.read();
    return data.allowances.filter((a) => a.userId === userId).map(({ kind, ref }) => ({ kind, ref }));
  }

  async isAllowed(actor: Principal, kind: AllowanceKind, ref: string): Promise<boolean> {
    const data = await this.store.read();
    return isAllowanceGranted(data, actor.userId, kind, ref);
  }

  async readAudit(actor: Principal, options?: { limit?: number }) {
    this.require(actor, "audit.read");
    return this.audit.list(options);
  }

  /** Administrator unlock of a throttled account or address. */
  unlockAccount(actor: Principal, username: string): void {
    this.require(actor, "users.manage");
    this.accountThrottle.reset(`u:${normalizeUsername(username)}`);
  }

  // ----------------------------------------------------------------- internals

  private async getDummyHash(): Promise<string> {
    return (this.dummyHash ??= this.hasher.hash("paseo-users-dummy-password"));
  }

  private assertUsername(username: string): void {
    if (!USERNAME_PATTERN.test(username)) throw new ConflictError("invalid username");
  }

  private require(actor: Principal, permission: Parameters<typeof has>[1]): void {
    if (!has(actor, permission)) throw new ForbiddenError(`${permission} required`);
  }

  private requireReturning<T>(actor: Principal, permission: Parameters<typeof has>[1], value: T): T {
    this.require(actor, permission);
    return value;
  }

  private requireSelfOr(actor: Principal, userId: string, permission: Parameters<typeof has>[1]): void {
    if (actor.userId !== userId && !has(actor, permission)) throw new ForbiddenError(`${permission} required`);
  }

  private findProject(data: StoreData, actor: Principal, projectId: string): Project {
    const project = data.projects.find((p) => p.id === projectId);
    // A project the caller cannot read is reported as missing so its existence is not disclosed.
    if (!project || !authorizeProject(actor, project, "read").allow) throw new NotFoundError("project");
    return project;
  }

  private assertAssignable(data: StoreData, actor: Principal, roleIds: readonly string[]): void {
    this.require(actor, "roles.manage");
    const known = new Set(data.roles.map((r) => r.id));
    if (roleIds.length === 0 || roleIds.some((id) => !known.has(id))) throw new ConflictError("unknown role");
    for (const permission of permissionsForRoles(data, roleIds)) {
      if (!actor.permissions.has(permission)) throw new ForbiddenError("cannot grant permissions you do not hold");
    }
  }

  /** An actor may only administer accounts whose permissions are a subset of their own. */
  private assertCanAdminister(data: StoreData, actor: Principal, target: User): void {
    for (const permission of permissionsForRoles(data, target.roleIds)) {
      if (!actor.permissions.has(permission)) throw new ForbiddenError("target holds permissions you do not");
    }
  }

  private assertAdministratorRemains(data: StoreData): void {
    const admins = data.users.filter((u) => u.status === "active" && permissionsForRoles(data, u.roleIds).has("users.manage"));
    if (admins.length === 0) throw new ForbiddenError("at least one active administrator must remain");
  }

  private usableInvitation(data: StoreData, token: string, kind: Invitation["kind"], now: Date): Invitation {
    const invalid = new ForbiddenError("invitation invalid");
    if (!looksLikeToken("invitation", token)) throw invalid;
    const hash = hashToken(token);
    const inv = data.invitations.find((i) => i.tokenHash === hash && i.kind === kind);
    if (!inv || inv.usedAt || inv.revokedAt || now >= new Date(inv.expiresAt)) throw invalid;
    return inv;
  }

  private async revokeSessions(match: (s: LoginSession) => boolean, reason: string, actorId: string): Promise<number> {
    const now = this.clock.now().toISOString();
    const revoked: string[] = [];
    await this.store.transact((data) => {
      for (const session of data.sessions) {
        if (!session.revokedAt && match(session)) {
          session.revokedAt = now;
          session.revokedReason = reason;
          revoked.push(session.id);
        }
      }
    });
    for (const id of revoked) {
      this.lastTouch.delete(id);
      await this.audit.record("auth.session.revoked", { actorId, targetId: id, detail: { reason } });
    }
    return revoked.length;
  }
}
