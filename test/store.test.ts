import { chmod, copyFile, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFileAuditLog, openJsonStore, rollbackToBackup, StoreCorruptError, UsersKernel } from "../server/kernel/index.js";
import { migrateRaw } from "../server/kernel/migrations.js";
import { FakeClock, PW, cheapHasher } from "./helpers.js";

const tmp = () => mkdtemp(join(tmpdir(), "pu-store-"));

describe("file-backed store", () => {
  it("creates files private to the owner and persists across reopen", async () => {
    const dir = await tmp();
    const path = join(dir, "users.json");
    const clock = new FakeClock();
    const open = async () => {
      const store = await openJsonStore({ path });
      return { store, kernel: new UsersKernel({ store, hasher: cheapHasher(), audit: createFileAuditLog(join(dir, "audit.jsonl"), clock), clock }) };
    };
    const first = await open();
    const bootstrap = (await first.kernel.issueBootstrapToken(dir))!;
    await first.kernel.initialize(dir, { bootstrapToken: bootstrap, username: "admin", password: PW.admin });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(join(dir, "audit.jsonl"))).mode & 0o777).toBe(0o600);

    const second = await open();
    expect(await second.kernel.isInitialized()).toBe(true);
    expect((await second.kernel.login({ username: "admin", password: PW.admin })).ok).toBe(true);
    const audit = await readFile(join(dir, "audit.jsonl"), "utf8");
    expect(audit).toContain("instance.initialized");
    expect(audit).not.toContain(PW.admin);
  });

  it("tightens a loosened file mode on load", async () => {
    const dir = await tmp();
    const path = join(dir, "users.json");
    await openJsonStore({ path });
    await chmod(path, 0o644);
    await openJsonStore({ path });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("refuses to start on a corrupt file instead of replacing it", async () => {
    const dir = await tmp();
    const path = join(dir, "users.json");
    await writeFile(path, "{ not json");
    await expect(openJsonStore({ path })).rejects.toBeInstanceOf(StoreCorruptError);
    expect(await readFile(path, "utf8")).toBe("{ not json");
  });

  it("refuses a structurally invalid store (e.g. tampered session record)", async () => {
    const dir = await tmp();
    const path = join(dir, "users.json");
    const store = await openJsonStore({ path });
    const raw = JSON.parse(await readFile(path, "utf8"));
    raw.sessions.push({ id: "x" });
    await writeFile(path, JSON.stringify(raw));
    await expect(openJsonStore({ path })).rejects.toBeInstanceOf(StoreCorruptError);
    void store;
  });

  it("a failed transaction leaves the on-disk state untouched", async () => {
    const dir = await tmp();
    const path = join(dir, "users.json");
    const store = await openJsonStore({ path });
    const before = await readFile(path, "utf8");
    await expect(store.transact((d) => { d.initialized = true; throw new Error("boom"); })).rejects.toThrow("boom");
    expect(await readFile(path, "utf8")).toBe(before);
    expect((await store.read()).initialized).toBe(false);
  });

  it("serializes concurrent transactions without losing updates", async () => {
    const dir = await tmp();
    const store = await openJsonStore({ path: join(dir, "users.json") });
    await Promise.all(Array.from({ length: 25 }, (_, i) => store.transact((d) => {
      d.allowances.push({ userId: "u", kind: "provider", ref: `p${i}`, grantedBy: "a", grantedAt: new Date().toISOString() });
    })));
    expect((await store.read()).allowances).toHaveLength(25);
  });
});

describe("migration and rollback", () => {
  it("refuses a store written by a newer version (downgrade guard)", async () => {
    const dir = await tmp();
    const path = join(dir, "users.json");
    await openJsonStore({ path });
    const raw = JSON.parse(await readFile(path, "utf8"));
    raw.schemaVersion = 99;
    await writeFile(path, JSON.stringify(raw));
    await expect(openJsonStore({ path })).rejects.toThrow(/newer than this build/);
    expect(JSON.parse(await readFile(path, "utf8")).schemaVersion).toBe(99); // untouched
  });

  it("migrates forward with a backup, and the backup restores the original bytes", async () => {
    const dir = await tmp();
    const path = join(dir, "users.json");
    await openJsonStore({ path });
    const original = await readFile(path, "utf8");
    const migrations = { 1: (raw: Record<string, unknown>) => ({ ...raw, note: "migrated" }) };
    // `note` is not in the schema; zod strips unknown keys, so this exercises the real path.
    const store = await openJsonStore({ path, migrations, targetVersion: 2 });
    expect((await store.read()).schemaVersion).toBe(2);
    expect(JSON.parse(await readFile(path, "utf8")).schemaVersion).toBe(2);
    await rollbackToBackup(path, 1);
    expect(await readFile(path, "utf8")).toBe(original);
    expect((await stat(join(dir, "users.json.v1.bak"))).mode & 0o777).toBe(0o600);
  });

  it("a failing migration rolls the file back byte-for-byte and reports the error", async () => {
    const dir = await tmp();
    const path = join(dir, "users.json");
    await openJsonStore({ path });
    const original = await readFile(path, "utf8");
    const migrations = { 1: () => { throw new Error("step exploded"); } };
    await expect(openJsonStore({ path, migrations, targetVersion: 2 })).rejects.toThrow("step exploded");
    expect(await readFile(path, "utf8")).toBe(original);
  });

  it("a migration producing an invalid shape is rolled back too", async () => {
    const dir = await tmp();
    const path = join(dir, "users.json");
    await openJsonStore({ path });
    const original = await readFile(path, "utf8");
    await expect(openJsonStore({ path, migrations: { 1: () => ({ users: "nope" }) }, targetVersion: 2 })).rejects.toThrow();
    expect(await readFile(path, "utf8")).toBe(original);
  });

  it("migrateRaw rejects missing versions and gaps", () => {
    expect(() => migrateRaw({}, {}, 1)).toThrow(/schemaVersion/);
    expect(() => migrateRaw({ schemaVersion: 1 }, {}, 3)).toThrow(/No migration from schema 1/);
  });
});

void copyFile;
