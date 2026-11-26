import { z } from "zod";
import { RoleSchema } from "./permissions.js";

/** Bump when the persisted shape changes; add a step in server/kernel/migrations.ts. */
export const STORE_SCHEMA_VERSION = 1;

const Iso = z.string().datetime();
const Id = z.string().min(1).max(64);

export const USERNAME_PATTERN = /^[a-z][a-z0-9._-]{1,31}$/;

export const UserSchema = z.object({
  id: Id,
  /** Lower-case, unique. Never shown as proof of identity to other users' clients. */
  username: z.string().regex(USERNAME_PATTERN),
  displayName: z.string().min(1).max(64),
  roleIds: z.array(z.string()).min(1),
  status: z.enum(["active", "disabled"]),
  /** PHC-style string, see server/kernel/password.ts. Null for accounts that cannot log in with a password. */
  passwordHash: z.string().nullable(),
  mustChangePassword: z.boolean(),
  passwordChangedAt: Iso.nullable(),
  createdAt: Iso,
  createdBy: Id.nullable(),
  disabledAt: Iso.nullable(),
  /** Unix account an execution layer should run this user's workloads as. Reference only. */
  unixAccount: z.string().max(64).nullable().default(null),
});
export type User = z.infer<typeof UserSchema>;

/** A login session. Only the SHA-256 of the bearer token is stored. */
export const LoginSessionSchema = z.object({
  id: Id,
  userId: Id,
  tokenHash: z.string().length(64),
  /** Stable device identity; lets Paseo device pairing map onto a user later. */
  deviceId: z.string().max(128).nullable(),
  deviceLabel: z.string().max(128).nullable(),
  createdAt: Iso,
  lastSeenAt: Iso,
  idleExpiresAt: Iso,
  absoluteExpiresAt: Iso,
  revokedAt: Iso.nullable(),
  revokedReason: z.string().max(64).nullable(),
  remoteAddress: z.string().max(64).nullable(),
});
export type LoginSession = z.infer<typeof LoginSessionSchema>;

/** One-time token for onboarding a new user or resetting a password. Only a hash is stored. */
export const InvitationSchema = z.object({
  id: Id,
  kind: z.enum(["invite", "reset"]),
  tokenHash: z.string().length(64),
  /** `invite`: roles the new account receives. `reset`: unused. */
  roleIds: z.array(z.string()),
  /** `reset`: the account being recovered. `invite`: null. */
  targetUserId: Id.nullable(),
  createdBy: Id,
  createdAt: Iso,
  expiresAt: Iso,
  usedAt: Iso.nullable(),
  usedBy: Id.nullable(),
  revokedAt: Iso.nullable(),
});
export type Invitation = z.infer<typeof InvitationSchema>;

/** Link to an external identity (OIDC, passkey, ...). Unused in the MVP; reserved so the model need not change. */
export const ExternalIdentitySchema = z.object({
  userId: Id,
  provider: z.string().min(1).max(64),
  subject: z.string().min(1).max(256),
  linkedAt: Iso,
});
export type ExternalIdentity = z.infer<typeof ExternalIdentitySchema>;

export const PROJECT_ACCESS = ["read", "write"] as const;
export const ProjectAccessSchema = z.enum(PROJECT_ACCESS);
export type ProjectAccess = z.infer<typeof ProjectAccessSchema>;

/**
 * A project known to paseo-users. `paseoRef` is how the Paseo daemon identifies the same thing
 * (project key / workspace id); the kernel never interprets it.
 */
export const ProjectSchema = z.object({
  id: Id,
  paseoRef: z.string().min(1).max(512),
  name: z.string().min(1).max(128),
  /** Null: administrator-owned, no personal owner. */
  ownerId: Id.nullable(),
  members: z.array(z.object({ userId: Id, access: ProjectAccessSchema, grantedBy: Id, grantedAt: Iso })),
  createdAt: Iso,
});
export type Project = z.infer<typeof ProjectSchema>;

/** A coding session (Paseo agent) and who owns it. Without this record nobody but an administrator can address it. */
export const SessionOwnershipSchema = z.object({
  paseoAgentId: z.string().min(1).max(128),
  ownerId: Id,
  projectId: Id.nullable(),
  createdAt: Iso,
});
export type SessionOwnership = z.infer<typeof SessionOwnershipSchema>;

export const ALLOWANCE_KINDS = ["profile", "sandbox", "provider", "credential", "host"] as const;
export const AllowanceKindSchema = z.enum(ALLOWANCE_KINDS);
export type AllowanceKind = z.infer<typeof AllowanceKindSchema>;

/**
 * Admin-managed allow-list entry: user may use `ref` of `kind`. `ref` is an identifier or
 * credential REFERENCE; raw secrets are never stored in this model.
 */
export const AllowanceSchema = z.object({
  userId: Id,
  kind: AllowanceKindSchema,
  ref: z.string().min(1).max(256),
  grantedBy: Id,
  grantedAt: Iso,
});
export type Allowance = z.infer<typeof AllowanceSchema>;

export const StoreSchema = z.object({
  schemaVersion: z.number().int().min(1),
  /** False until the first administrator exists. */
  initialized: z.boolean(),
  roles: z.array(RoleSchema),
  users: z.array(UserSchema),
  sessions: z.array(LoginSessionSchema),
  invitations: z.array(InvitationSchema),
  externalIdentities: z.array(ExternalIdentitySchema),
  projects: z.array(ProjectSchema),
  sessionOwnership: z.array(SessionOwnershipSchema),
  allowances: z.array(AllowanceSchema),
});
export type StoreData = z.infer<typeof StoreSchema>;

export const AUDIT_EVENT_TYPES = [
  "instance.initialized",
  "auth.login.success",
  "auth.login.failure",
  "auth.login.throttled",
  "auth.logout",
  "auth.session.revoked",
  "auth.password.changed",
  "auth.password.reset_issued",
  "auth.password.reset_used",
  "user.created",
  "user.updated",
  "user.disabled",
  "user.enabled",
  "user.deleted",
  "user.roles.changed",
  "invitation.created",
  "invitation.used",
  "invitation.revoked",
  "project.created",
  "project.shared",
  "project.unshared",
  "project.deleted",
  "allowance.granted",
  "allowance.revoked",
  "authz.denied",
  "authz.admin_override",
  "store.migrated",
] as const;
export type AuditEventType = (typeof AUDIT_EVENT_TYPES)[number];

export const AuditEventSchema = z.object({
  at: Iso,
  type: z.enum(AUDIT_EVENT_TYPES),
  actorId: Id.nullable(),
  targetId: z.string().max(128).nullable(),
  /** Non-secret context only. Never passwords, tokens, hashes. */
  detail: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).default({}),
});
export type AuditEvent = z.infer<typeof AuditEventSchema>;
