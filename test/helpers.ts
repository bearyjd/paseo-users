import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  UsersKernel,
  createMemoryAuditLog,
  createMemoryStore,
  createPasswordHasher,
  type Clock,
  type KernelConfig,
  type Principal,
} from "../server/kernel/index.js";

export class FakeClock implements Clock {
  constructor(private time = new Date("2026-01-01T00:00:00.000Z")) {}
  now(): Date {
    return new Date(this.time);
  }
  advance(ms: number): void {
    this.time = new Date(this.time.getTime() + ms);
  }
}

export const PW = {
  admin: "correct horse battery staple",
  dev: "an entirely different passphrase",
  other: "yet another long passphrase 42",
};

/** Real scrypt, deliberately cheap (2^10) so tests are fast. Production default is 2^17. */
export const cheapHasher = () => createPasswordHasher({ params: { ln: 10, r: 8, p: 1 } });

export async function makeKernel(config: Partial<KernelConfig> = {}) {
  const clock = new FakeClock();
  const store = createMemoryStore();
  const audit = createMemoryAuditLog(clock);
  const kernel = new UsersKernel({ store, hasher: cheapHasher(), audit, clock, config });
  const dir = await mkdtemp(join(tmpdir(), "paseo-users-test-"));
  const token = await kernel.issueBootstrapToken(dir);
  const { userId: adminId } = await kernel.initialize(dir, {
    bootstrapToken: token!,
    username: "admin",
    password: PW.admin,
  });
  const loginAs = async (username: string, password: string): Promise<Principal> => {
    const result = await kernel.login({ username, password, remoteAddress: "10.0.0.1" });
    if (!result.ok) throw new Error(`login failed: ${result.reason}`);
    const principal = await kernel.authenticate(result.token);
    if (!principal) throw new Error("authenticate failed");
    return principal;
  };
  const admin = await loginAs("admin", PW.admin);
  return { kernel, clock, store, audit, dir, admin, adminId, loginAs };
}

/** An administrator plus two developers, alice and bob, each with a live principal. */
export async function makeHousehold(config: Partial<KernelConfig> = {}) {
  const ctx = await makeKernel(config);
  const { kernel, admin, loginAs } = ctx;
  const { userId: aliceId } = await kernel.createUser(admin, { username: "alice", roleIds: ["developer"], initialPassword: PW.dev });
  const { userId: bobId } = await kernel.createUser(admin, { username: "bob", roleIds: ["developer"], initialPassword: PW.other });
  const alice = await loginAs("alice", PW.dev);
  const bob = await loginAs("bob", PW.other);
  return { ...ctx, aliceId, bobId, alice, bob };
}
