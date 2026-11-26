import { STORE_SCHEMA_VERSION } from "../../shared/model.js";

/**
 * Persisted-state migrations. Each step upgrades `from` -> `from + 1` on the raw JSON, before
 * schema validation. Steps must be pure. The store writes a backup before running any step
 * and restores it if a step or the final validation throws (see json-store.ts).
 */
export type MigrationStep = (raw: Record<string, unknown>) => Record<string, unknown>;

export const MIGRATIONS: Readonly<Record<number, MigrationStep>> = {
  // Version 1 is the first release; there is nothing to upgrade from.
};

export function migrateRaw(
  raw: Record<string, unknown>,
  steps: Readonly<Record<number, MigrationStep>> = MIGRATIONS,
  target: number = STORE_SCHEMA_VERSION,
): { data: Record<string, unknown>; from: number; to: number } {
  const from = Number(raw.schemaVersion);
  if (!Number.isInteger(from) || from < 1) throw new Error("Unreadable store: missing schemaVersion");
  if (from > target) {
    // A newer paseo-users wrote this. Refuse rather than guess; this is the rollback guard.
    throw new Error(`Store schema ${from} is newer than this build supports (${target}); refusing to load`);
  }
  let current = raw;
  for (let version = from; version < target; version++) {
    const step = steps[version];
    if (!step) throw new Error(`No migration from schema ${version}`);
    current = { ...step(current), schemaVersion: version + 1 };
  }
  return { data: current, from, to: target };
}
