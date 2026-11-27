import type { Status } from "../shared/status.js";
import { NO_CORE_ENFORCEMENT, type CoreEnforcement } from "./kernel/daemon-mapping.js";

export const PLUGIN_VERSION = "0.1.0";

/**
 * Detection of a core extension does not exist yet, so enforcement is always reported as `none`.
 * When the daemon exposes its enforcement capabilities (docs/05-core-extension-requirements.md),
 * read them here; never infer `enforced` from anything the plugin itself controls.
 */
export function readStatus(enforcement: CoreEnforcement = NO_CORE_ENFORCEMENT): Status {
  const blockedBy = (Object.keys(enforcement) as Array<keyof CoreEnforcement>).filter((key) => !enforcement[key]);
  return {
    plugin: "paseo-users",
    version: PLUGIN_VERSION,
    enforcement: blockedBy.length === 0 ? "enforced" : "none",
    contractVersion: 1,
    blockedBy,
  };
}
