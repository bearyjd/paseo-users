import { z } from "zod";
import { UsersPermissionSchema } from "./permissions.js";

/**
 * Integration contract between paseo-users and a Profiles plugin (v1).
 *
 * Direction of dependency: Profiles MAY read this context; paseo-users never imports Profiles.
 * A Profiles plugin that does not find paseo-users runs exactly as it does today (single user),
 * and paseo-users works with no Profiles plugin installed.
 *
 * Rule that makes profiles safe: a profile is a REQUEST. `evaluateProfileRequest` (server side,
 * in paseo-users) intersects it with what the authenticated user is authorized to use. Editing a
 * profile can only ask for more; it can never grant more.
 */
export const PROFILES_CONTRACT_VERSION = 1 as const;

export const UsersContextV1Schema = z.object({
  contractVersion: z.literal(PROFILES_CONTRACT_VERSION),
  /**
   * `none`: paseo-users is installed but the daemon is not enforcing it (no core extension).
   * `enforced`: the daemon admits only authenticated principals and scopes their resources.
   * Profiles must treat `none` like a single-user deployment and MUST NOT present
   * the context as a security boundary.
   */
  enforcement: z.enum(["none", "enforced"]),
  /** Null when no authenticated user (single-user or unenforced). */
  user: z
    .object({
      id: z.string(),
      username: z.string(),
      displayName: z.string(),
      roleIds: z.array(z.string()),
    })
    .nullable(),
  capabilities: z.array(UsersPermissionSchema),
  permitted: z.object({
    /** Admin-managed or user-owned profile ids this user may select. */
    profiles: z.array(z.string()),
    /** AI provider ids (`claude`, `codex`, ...). */
    providers: z.array(z.string()),
    /** Execution environment ids (`native`, `podman:default`, `vm:...`). */
    sandboxes: z.array(z.string()),
    /** Credential REFERENCES (opaque ids). Never secret values. */
    credentialRefs: z.array(z.string()),
    hosts: z.array(z.string()),
  }),
});
export type UsersContextV1 = z.infer<typeof UsersContextV1Schema>;

export const ProfileRequestV1Schema = z.object({
  providers: z.array(z.string()).default([]),
  sandbox: z.string().nullable().default(null),
  credentialRefs: z.array(z.string()).default([]),
  profileId: z.string().nullable().default(null),
});
export type ProfileRequestV1 = z.infer<typeof ProfileRequestV1Schema>;

export interface ProfileDecisionV1 {
  allowed: boolean;
  granted: ProfileRequestV1;
  denied: Array<{ kind: "provider" | "sandbox" | "credential" | "profile"; ref: string }>;
}

/** Deny-by-default intersection. An unenforced context returns an unconditional denial of anything it cannot vouch for. */
export function evaluateProfileRequest(ctx: UsersContextV1, request: ProfileRequestV1): ProfileDecisionV1 {
  const denied: ProfileDecisionV1["denied"] = [];
  const keep = (kind: ProfileDecisionV1["denied"][number]["kind"], refs: string[], allowed: string[]) =>
    refs.filter((ref) => {
      if (allowed.includes(ref)) return true;
      denied.push({ kind, ref });
      return false;
    });
  const providers = keep("provider", request.providers, ctx.permitted.providers);
  const credentialRefs = keep("credential", request.credentialRefs, ctx.permitted.credentialRefs);
  const sandbox = request.sandbox && keep("sandbox", [request.sandbox], ctx.permitted.sandboxes)[0];
  const profileId = request.profileId && keep("profile", [request.profileId], ctx.permitted.profiles)[0];
  return {
    allowed: denied.length === 0,
    granted: { providers, credentialRefs, sandbox: sandbox || null, profileId: profileId || null },
    denied,
  };
}
