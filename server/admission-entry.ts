import { createKernelAdmissionProvider, type DaemonAdmissionProvider } from "./admission.js";
import { dataDirFor, openKernel } from "./init.js";
import type { CoreEnforcement } from "./kernel/daemon-mapping.js";

/**
 * What the daemon this build targets (feat/users-admission) enforces. Admission and plugin caller
 * identity exist; resource scoping (R3) and redacted daemon.read (R7) do not, so developer accounts
 * are not admitted (see daemon-mapping.ts). Update only when core reports the capability.
 */
const ENFORCEMENT: CoreEnforcement = {
  principalAdmission: true,
  resourceScopedGrants: false,
  redactedDaemonRead: false,
  pluginCallerIdentity: true,
};

/** Loaded by the daemon via PASEO_ADMISSION_MODULE. */
export async function createAdmissionProvider(context: {
  paseoHome: string;
  logger: { warn(message: string): void; info(message: string): void };
}): Promise<DaemonAdmissionProvider> {
  const kernel = await openKernel(dataDirFor(context.paseoHome));
  if (!(await kernel.isInitialized())) {
    context.logger.warn("paseo-users: no administrator exists yet; run init-cli. Only the local operator can connect.");
  }
  return createKernelAdmissionProvider(kernel, ENFORCEMENT);
}
