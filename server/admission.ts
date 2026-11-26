import { z } from "zod";
import type { UsersKernel } from "./kernel/kernel.js";
import { ConflictError, ForbiddenError, InvalidInputError, NotFoundError } from "./kernel/kernel.js";
import { PasswordPolicyError } from "./kernel/password.js";
import type { Principal } from "./kernel/authz.js";
import { daemonPermissionsFor, type CoreEnforcement } from "./kernel/daemon-mapping.js";

/**
 * The daemon-facing adapter. The shapes below mirror `AdmissionProvider` in Paseo core
 * (packages/server/src/server/authorization/admission-provider.ts on the feat/users-admission
 * branch). They are declared structurally so this package keeps no import of Paseo internals.
 */
export interface DaemonAdmission {
  principalId: string;
  permissions: readonly string[];
}
export interface DaemonAdmissionEvent {
  principalId: string;
  permissions: readonly string[] | null;
}
export interface DaemonHttpRequest {
  method: string;
  path: string;
  headers: Record<string, string | undefined>;
  body: unknown;
  remoteAddress?: string;
}
export interface DaemonAdmissionProvider {
  authenticate(token: string, context: { clientId: string; remoteAddress?: string }): Promise<DaemonAdmission | null>;
  http(request: DaemonHttpRequest): Promise<{ status: number; body: unknown }>;
  subscribe(listener: (event: DaemonAdmissionEvent) => void): () => void;
}

const LoginBody = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(512),
  deviceId: z.string().max(128).optional(),
  deviceLabel: z.string().max(128).optional(),
});

/**
 * One daemon principal per LOGIN SESSION (`user:<userId>:<loginSessionId>`), so revoking a device
 * closes that device's connections and nothing else, while disabling a user revokes every session.
 */
export const principalIdFor = (userId: string, loginSessionId: string): string => `user:${userId}:${loginSessionId}`;

export function createKernelAdmissionProvider(kernel: UsersKernel, enforcement: CoreEnforcement): DaemonAdmissionProvider {
  const listeners = new Set<(event: DaemonAdmissionEvent) => void>();
  kernel.onSessionsRevoked((revoked) => {
    for (const { userId, sessionId } of revoked) {
      for (const listener of listeners) listener({ principalId: principalIdFor(userId, sessionId), permissions: null });
    }
  });

  async function authenticate(token: string): Promise<DaemonAdmission | null> {
    const principal = await kernel.authenticate(token);
    if (!principal) return null;
    const grant = daemonPermissionsFor(principal.permissions, enforcement);
    // Fail closed: a user the daemon cannot safely scope is not admitted at all.
    if (!grant.ok) return null;
    return { principalId: principalIdFor(principal.userId, principal.loginSessionId), permissions: grant.permissions };
  }

  const reply = (status: number, body: unknown = { ok: true }) => ({ status, body });

  async function login(body: unknown, remoteAddress: string | undefined) {
    const parsed = LoginBody.safeParse(body);
    if (!parsed.success) return reply(400, { error: "invalid_request" });
    const result = await kernel.login({
      username: parsed.data.username,
      password: parsed.data.password,
      remoteAddress: remoteAddress ?? null,
      deviceId: parsed.data.deviceId ?? null,
      deviceLabel: parsed.data.deviceLabel ?? null,
    });
    if (!result.ok) {
      return result.reason === "throttled"
        ? reply(429, { error: "throttled", retryAfterMs: result.retryAfterMs })
        : reply(401, { error: "invalid_credentials" });
    }
    const principal = await kernel.authenticate(result.token);
    const grant = principal ? daemonPermissionsFor(principal.permissions, enforcement) : null;
    if (!principal || !grant?.ok) {
      // Valid identity, but this daemon cannot enforce the scoping the account needs.
      if (principal) await kernel.logout(principal);
      return reply(403, { error: "daemon_access_unavailable", blockedBy: grant && !grant.ok ? grant.blockedBy : [] });
    }
    return reply(200, { token: result.token, userId: result.userId, mustChangePassword: result.mustChangePassword });
  }

  async function caller(request: DaemonHttpRequest): Promise<Principal | null> {
    const header = request.headers.authorization ?? "";
    const match = /^Bearer (\S+)$/.exec(header);
    return match?.[1] ? kernel.authenticate(match[1]) : null;
  }

  /** Every route below authenticates the bearer token and lets the kernel authorize the action. */
  async function route(request: DaemonHttpRequest) {
    const key = `${request.method.toUpperCase()} ${request.path}`;
    if (key === "POST /login") return login(request.body, request.remoteAddress);
    const principal = await caller(request);
    if (!principal) return reply(401, { error: "unauthenticated" });
    const body = (request.body ?? {}) as Record<string, unknown>;
    switch (key) {
      case "GET /me":
        return reply(200, { userId: principal.userId, username: principal.username, roleIds: principal.roleIds });
      case "POST /logout":
        await kernel.logout(principal);
        return reply(200);
      case "GET /sessions": {
        const sessions = await kernel.listLoginSessions(principal, principal.userId);
        return reply(200, sessions.map((s) => ({ id: s.id, deviceLabel: s.deviceLabel, createdAt: s.createdAt, lastSeenAt: s.lastSeenAt, current: s.id === principal.loginSessionId })));
      }
      case "POST /sessions/revoke":
        await kernel.revokeLoginSession(principal, str(body.sessionId));
        return reply(200);
      case "POST /users": {
        const created = await kernel.createUser(principal, {
          username: str(body.username),
          roleIds: strs(body.roleIds),
          initialPassword: str(body.initialPassword),
          ...(typeof body.displayName === "string" ? { displayName: body.displayName } : {}),
        });
        return reply(201, created);
      }
      case "POST /users/status":
        await kernel.setUserStatus(principal, str(body.userId), body.status === "disabled" ? "disabled" : "active");
        return reply(200);
      case "POST /users/revoke-sessions":
        return reply(200, { revoked: await kernel.revokeAllLoginSessions(principal, str(body.userId)) });
      default:
        return reply(404, { error: "not_found" });
    }
  }

  return {
    authenticate: (token) => authenticate(token),

    async http(request) {
      try {
        return await route(request);
      } catch (error) {
        return errorResponse(error);
      }
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

const str = (value: unknown): string => (typeof value === "string" ? value : "");
const strs = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []);

/** Maps kernel errors to HTTP without leaking internals; anything unexpected becomes a bare 500. */
function errorResponse(error: unknown): { status: number; body: unknown } {
  if (error instanceof ForbiddenError) return { status: 403, body: { error: "forbidden" } };
  if (error instanceof NotFoundError) return { status: 404, body: { error: "not_found" } };
  if (error instanceof InvalidInputError) return { status: 400, body: { error: "invalid_input" } };
  if (error instanceof ConflictError) return { status: 409, body: { error: "conflict" } };
  if (error instanceof PasswordPolicyError) return { status: 400, body: { error: "password_policy", message: error.message } };
  return { status: 500, body: { error: "internal_error" } };
}
