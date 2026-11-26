import { chmod, copyFile, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { BUILTIN_ROLES } from "../../shared/permissions.js";
import { STORE_SCHEMA_VERSION, StoreSchema, type StoreData } from "../../shared/model.js";
import { MIGRATIONS, migrateRaw, type MigrationStep } from "./migrations.js";

export function emptyStore(): StoreData {
  return {
    schemaVersion: STORE_SCHEMA_VERSION,
    initialized: false,
    roles: BUILTIN_ROLES.map((role) => ({ ...role, permissions: [...role.permissions] })),
    users: [],
    sessions: [],
    invitations: [],
    externalIdentities: [],
    projects: [],
    sessionOwnership: [],
    allowances: [],
  };
}

export interface Store {
  /** Runs `fn` against a private copy under an exclusive lock; commits atomically if it returns. */
  transact<T>(fn: (data: StoreData) => T | Promise<T>): Promise<T>;
  /** Read-only snapshot (a deep copy; mutating it changes nothing). */
  read(): Promise<StoreData>;
}

export class StoreCorruptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoreCorruptError";
  }
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

class Mutex {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn, fn);
    this.tail = result.catch(() => undefined);
    return result;
  }
}

export function createMemoryStore(initial: StoreData = emptyStore()): Store {
  let data = clone(initial);
  const mutex = new Mutex();
  return {
    read: () => mutex.run(async () => clone(data)),
    transact: (fn) =>
      mutex.run(async () => {
        const draft = clone(data);
        const result = await fn(draft);
        data = StoreSchema.parse(draft);
        return result;
      }),
  };
}

export interface JsonStoreOptions {
  path: string;
  /** Injected for migration tests. */
  migrations?: Readonly<Record<number, MigrationStep>>;
  targetVersion?: number;
}

/**
 * File-backed store matching Paseo's own persistence conventions: one JSON document, Zod-validated on
 * load, written atomically (temp file + fsync + rename), mode 0600 in a 0700 directory.
 * Single process, single writer: the identity service must be the only writer. A corrupt or
 * future-versioned file is a hard error, never silently replaced, because replacing it would
 * wipe every account and session.
 */
export async function openJsonStore(options: JsonStoreOptions): Promise<Store> {
  const { path } = options;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const mutex = new Mutex();
  let data = await load(options);

  async function commit(next: StoreData): Promise<void> {
    const tmp = `${path}.${process.pid}.tmp`;
    const handle = await open(tmp, "w", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(next, null, 2)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await chmod(tmp, 0o600);
    await rename(tmp, path);
  }

  return {
    read: () => mutex.run(async () => clone(data)),
    transact: (fn) =>
      mutex.run(async () => {
        const draft = clone(data);
        const result = await fn(draft);
        const validated = StoreSchema.parse(draft);
        await commit(validated);
        data = validated;
        return result;
      }),
  };
}

async function load(options: JsonStoreOptions): Promise<StoreData> {
  const { path } = options;
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const fresh = emptyStore();
    const handle = await open(path, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(fresh, null, 2)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    return fresh;
  }
  // Keep the file private even if something loosened it.
  if (((await stat(path)).mode & 0o077) !== 0) await chmod(path, 0o600);

  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new StoreCorruptError(`${path} is not valid JSON; refusing to start`);
  }
  const target = options.targetVersion ?? STORE_SCHEMA_VERSION;
  const steps = options.migrations ?? MIGRATIONS;
  const version = Number(raw.schemaVersion);
  if (version === target) {
    const parsed = StoreSchema.safeParse(raw);
    if (!parsed.success) throw new StoreCorruptError(`${path} failed validation: ${parsed.error.message}`);
    return parsed.data;
  }

  // Migration path: back up first, restore on any failure.
  const backup = join(dirname(path), `${path.split("/").pop()}.v${version}.bak`);
  await copyFile(path, backup);
  await chmod(backup, 0o600);
  try {
    const migrated = migrateRaw(raw, steps, target);
    const parsed = StoreSchema.parse(migrated.data);
    const tmp = `${path}.${process.pid}.tmp`;
    const handle = await open(tmp, "w", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(parsed, null, 2)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmp, path);
    return parsed;
  } catch (error) {
    await copyFile(backup, path); // rollback: the original bytes are back
    await rm(`${path}.${process.pid}.tmp`, { force: true });
    throw error;
  }
}

/** Restore the pre-migration backup for `fromVersion` over the live file (operator rollback). */
export async function rollbackToBackup(path: string, fromVersion: number): Promise<void> {
  const backup = join(dirname(path), `${path.split("/").pop()}.v${fromVersion}.bak`);
  await copyFile(backup, path);
  await chmod(path, 0o600);
}
