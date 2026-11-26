import type { UsersContextV1 } from "../../shared/profiles-contract.js";
import { PROFILES_CONTRACT_VERSION } from "../../shared/profiles-contract.js";
import type { Principal } from "./authz.js";
import type { UsersKernel } from "./kernel.js";
import type { CoreEnforcement } from "./daemon-mapping.js";
import type { AllowanceKind } from "../../shared/model.js";

/** Builds the v1 context a Profiles plugin may read for the authenticated caller. */
export async function buildUsersContext(
  kernel: UsersKernel,
  principal: Principal | null,
  enforcement: CoreEnforcement,
  lookup: { displayName: string } | null = null,
): Promise<UsersContextV1> {
  const enforced = enforcement.principalAdmission && enforcement.resourceScopedGrants;
  if (!principal || !enforced) {
    return {
      contractVersion: PROFILES_CONTRACT_VERSION,
      enforcement: enforced ? "enforced" : "none",
      user: null,
      capabilities: [],
      permitted: { profiles: [], providers: [], sandboxes: [], credentialRefs: [], hosts: [] },
    };
  }
  const allowances = await kernel.allowancesFor(principal, principal.userId);
  const refs = (kind: AllowanceKind) => allowances.filter((a) => a.kind === kind).map((a) => a.ref);
  return {
    contractVersion: PROFILES_CONTRACT_VERSION,
    enforcement: "enforced",
    user: {
      id: principal.userId,
      username: principal.username,
      displayName: lookup?.displayName ?? principal.username,
      roleIds: [...principal.roleIds],
    },
    capabilities: [...principal.permissions],
    permitted: {
      profiles: refs("profile"),
      providers: refs("provider"),
      sandboxes: refs("sandbox"),
      credentialRefs: refs("credential"),
      hosts: refs("host"),
    },
  };
}
