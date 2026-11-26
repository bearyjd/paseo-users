import type { UsersPermission } from "../../shared/permissions.js";

/**
 * Paseo's own semantic daemon permissions (packages/protocol/src/messages.ts DAEMON_PERMISSIONS,
 * v0.17.5). Mirrored here as strings so the kernel has no Paseo dependency; the test suite
 * pins this list so drift is caught when the snapshot is refreshed.
 */
export const PASEO_DAEMON_PERMISSIONS = [
  "daemon.read",
  "daemon.manage",
  "tunnel.manage",
  "access.manage",
  "workspace.read",
  "workspace.write",
  "workspace.manage",
  "automation.manage",
  "hub.execute",
] as const;
export type PaseoDaemonPermission = (typeof PASEO_DAEMON_PERMISSIONS)[number];

/**
 * What the running daemon can actually enforce. Reported by the core extension (see
 * docs/05-core-extension-requirements.md). Today's upstream daemon reports all false.
 */
export interface CoreEnforcement {
  /** Daemon admits sessions through a principal-aware admission provider, not just the shared password. */
  principalAdmission: boolean;
  /** Daemon filters inbound operations and outbound events to the principal's workspaces/agents/terminals/files. */
  resourceScopedGrants: boolean;
  /** daemon.read no longer exposes configuration, provider credentials, or other users' data. */
  redactedDaemonRead: boolean;
  /** Plugin RPC handlers receive the authenticated caller. */
  pluginCallerIdentity: boolean;
}

export const NO_CORE_ENFORCEMENT: CoreEnforcement = {
  principalAdmission: false,
  resourceScopedGrants: false,
  redactedDaemonRead: false,
  pluginCallerIdentity: false,
};

export type DaemonGrantResult =
  | { ok: true; permissions: PaseoDaemonPermission[] }
  | { ok: false; permissions: []; blockedBy: Array<keyof CoreEnforcement> };

/**
 * Translates a user's paseo-users permissions into daemon permissions. Fails closed: when the
 * daemon cannot enforce the scoping a non-administrator needs, the result is NO permissions
 * and the reason, never a daemon-wide grant. Unscoped `workspace.*` on one shared daemon would
 * let every developer read and drive every other user's agents and terminals.
 */
export function daemonPermissionsFor(
  permissions: ReadonlySet<UsersPermission>,
  enforcement: CoreEnforcement,
): DaemonGrantResult {
  if (!enforcement.principalAdmission) {
    return { ok: false, permissions: [], blockedBy: ["principalAdmission"] };
  }
  const isAdmin = permissions.has("users.manage") && permissions.has("projects.manage_any");
  if (isAdmin) return { ok: true, permissions: [...PASEO_DAEMON_PERMISSIONS] };

  if (permissions.has("sessions.own")) {
    const blockedBy: Array<keyof CoreEnforcement> = [];
    if (!enforcement.resourceScopedGrants) blockedBy.push("resourceScopedGrants");
    if (!enforcement.redactedDaemonRead) blockedBy.push("redactedDaemonRead");
    if (blockedBy.length > 0) return { ok: false, permissions: [], blockedBy };
    // workspace.manage lets a developer register and archive THEIR workspaces; the core
    // scope check (resourceScopedGrants) bounds it to those. Daemon, tunnel, access, hub and
    // automation authority stay administrator-only: schedules and loops are daemon-wide today.
    return { ok: true, permissions: ["daemon.read", "workspace.read", "workspace.write", "workspace.manage"] };
  }
  return { ok: true, permissions: [] };
}
