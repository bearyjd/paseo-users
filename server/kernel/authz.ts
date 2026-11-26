import type { Project, SessionOwnership, StoreData } from "../../shared/model.js";
import type { UsersPermission } from "../../shared/permissions.js";

/**
 * The authenticated caller, as resolved by the kernel from a live login session. Everything
 * the authorizer needs is on this object; nothing here is client-supplied.
 */
export interface Principal {
  userId: string;
  username: string;
  roleIds: readonly string[];
  permissions: ReadonlySet<UsersPermission>;
  loginSessionId: string;
}

export type Decision = { allow: true; adminOverride?: boolean } | { allow: false; reason: string };
const allow: Decision = { allow: true };
const deny = (reason: string): Decision => ({ allow: false, reason });

export function permissionsForRoles(data: StoreData, roleIds: readonly string[]): Set<UsersPermission> {
  const permissions = new Set<UsersPermission>();
  for (const role of data.roles) {
    if (roleIds.includes(role.id)) for (const permission of role.permissions) permissions.add(permission);
  }
  return permissions;
}

export function has(principal: Principal, permission: UsersPermission): boolean {
  return principal.permissions.has(permission);
}

export type ProjectLevel = "none" | "read" | "write" | "owner" | "admin";

export function projectLevel(principal: Principal, project: Project): ProjectLevel {
  if (has(principal, "projects.manage_any")) return "admin";
  if (project.ownerId === principal.userId) return "owner";
  const member = project.members.find((m) => m.userId === principal.userId);
  return member ? member.access : "none";
}

const RANK: Record<ProjectLevel, number> = { none: 0, read: 1, write: 2, owner: 3, admin: 4 };
export const atLeast = (level: ProjectLevel, needed: ProjectLevel): boolean => RANK[level] >= RANK[needed];

export function authorizeProject(
  principal: Principal,
  project: Project,
  action: "read" | "write" | "share" | "delete",
): Decision {
  const level = projectLevel(principal, project);
  switch (action) {
    case "read":
      return atLeast(level, "read") ? allow : deny("no access to project");
    case "write":
      return atLeast(level, "write") ? allow : deny("no write access to project");
    case "share":
      if (level === "admin") return allow;
      return level === "owner" && has(principal, "projects.share") ? allow : deny("not permitted to share project");
    case "delete":
      return level === "owner" || level === "admin" ? allow : deny("not permitted to delete project");
  }
}

/**
 * Coding-session access. Ownership is required for anything that drives the session. Reading
 * someone else's session needs `sessions.read_any` and is reported as an admin override so the
 * caller can audit it. A session with no ownership record is addressable only by an
 * administrator: unknown means denied.
 *
 * Access to a session also requires the CURRENT right to its project, so revoking a share cuts
 * off the sessions that were created under it.
 */
export function authorizeAgentSession(
  principal: Principal,
  ownership: SessionOwnership | undefined,
  project: Project | undefined,
  action: "read" | "write",
): Decision {
  if (!ownership) {
    return has(principal, "sessions.read_any") && action === "read"
      ? { allow: true, adminOverride: true }
      : deny("unknown session");
  }
  if (ownership.ownerId === principal.userId) {
    if (!has(principal, "sessions.own")) return deny("sessions not permitted");
    if (ownership.projectId) {
      if (!project) return deny("session project no longer exists");
      const needed = action === "write" ? "write" : "read";
      if (!atLeast(projectLevel(principal, project), needed)) return deny("project access revoked");
    }
    return allow;
  }
  if (action === "read" && has(principal, "sessions.read_any")) return { allow: true, adminOverride: true };
  return deny("session belongs to another user");
}

/** Can `actor` assign `roleIds` to `target`? Delegation rule: nobody grants authority they lack. */
export function authorizeRoleAssignment(
  data: StoreData,
  actor: Principal,
  targetUserId: string,
  roleIds: readonly string[],
): Decision {
  if (!has(actor, "roles.manage")) return deny("roles.manage required");
  if (targetUserId === actor.userId) return deny("cannot change own roles");
  const known = new Set(data.roles.map((role) => role.id));
  if (roleIds.length === 0 || roleIds.some((id) => !known.has(id))) return deny("unknown role");
  const granted = permissionsForRoles(data, roleIds);
  for (const permission of granted) {
    if (!actor.permissions.has(permission)) return deny("cannot grant permissions you do not hold");
  }
  return allow;
}

export function isAllowanceGranted(data: StoreData, userId: string, kind: string, ref: string): boolean {
  return data.allowances.some((a) => a.userId === userId && a.kind === kind && a.ref === ref);
}
