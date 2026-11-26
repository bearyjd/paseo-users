import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createFileAuditLog } from "./kernel/audit.js";
import { systemClock } from "./kernel/clock.js";
import { openJsonStore } from "./kernel/json-store.js";
import { UsersKernel } from "./kernel/kernel.js";
import { createPasswordHasher } from "./kernel/password.js";

export function dataDirFor(paseoHome: string): string {
  return join(paseoHome, "plugin-data", "paseo-users");
}

export async function openKernel(dataDir: string): Promise<UsersKernel> {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const clock = systemClock;
  return new UsersKernel({
    store: await openJsonStore({ path: join(dataDir, "users.json") }),
    hasher: createPasswordHasher(),
    audit: createFileAuditLog(join(dataDir, "audit.jsonl"), clock),
    clock,
  });
}

/**
 * First-run: creates the initial administrator. The operator runs this on the daemon host, so the
 * bootstrap token never leaves the machine: it is written to and consumed from the data directory.
 */
export async function initializeInstance(
  dataDir: string,
  input: { username: string; password: string; displayName?: string },
): Promise<{ userId: string }> {
  const kernel = await openKernel(dataDir);
  const token = await kernel.issueBootstrapToken(dataDir);
  if (!token) throw new Error("Already initialized");
  return kernel.initialize(dataDir, { bootstrapToken: token, ...input });
}
