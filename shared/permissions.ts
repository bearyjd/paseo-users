import { z } from "zod";

/**
 * paseo-users permissions. These are NOT Paseo daemon permissions
 * (`workspace.read`, `daemon.manage`, ...). They describe what an authenticated
 * user may do inside the paseo-users model. `server/kernel/daemon-mapping.ts` is the only
 * place that relates the two vocabularies, and it fails closed.
 *
 * Permissions are additive allows. Absent means denied. There is no deny precedence.
 */
export const USERS_PERMISSIONS = [
  // Account administration
  "users.manage", // create, modify, disable, delete accounts; issue invitations and resets
  "roles.manage", // assign roles (bounded by the delegation rule)
  "sessions.revoke_any", // revoke any user's login sessions and devices
  "audit.read", // read security and administrative events
  // Resource administration
  "projects.manage_any", // see and administer every project, manage its grants
  "hosts.manage", // host access policy
  "policy.manage", // allowed profiles, sandboxes, AI providers, credential references
  "sessions.read_any", // read other users' coding sessions (explicit, audited)
  // Developer capabilities
  "projects.create", // register a project owned by the caller
  "projects.share", // share a project the caller owns
  "sessions.own", // create and use the caller's own coding sessions
  "preferences.own", // personal preferences
] as const;

export const UsersPermissionSchema = z.enum(USERS_PERMISSIONS);
export type UsersPermission = z.infer<typeof UsersPermissionSchema>;

export const BUILTIN_ROLE_IDS = ["administrator", "developer"] as const;
export type BuiltinRoleId = (typeof BUILTIN_ROLE_IDS)[number];

export const RoleSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_-]{1,31}$/),
  name: z.string().min(1).max(64),
  builtin: z.boolean(),
  permissions: z.array(UsersPermissionSchema),
});
export type Role = z.infer<typeof RoleSchema>;

/**
 * Built-in roles. Developers deliberately get no administrative permission, and no
 * `sessions.read_any`: reading another user's sessions is an administrator decision.
 */
export const BUILTIN_ROLES: readonly Role[] = [
  {
    id: "administrator",
    name: "Administrator",
    builtin: true,
    permissions: [...USERS_PERMISSIONS],
  },
  {
    id: "developer",
    name: "Developer",
    builtin: true,
    permissions: ["projects.create", "projects.share", "sessions.own", "preferences.own"],
  },
];
