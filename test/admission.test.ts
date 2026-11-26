import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createKernelAdmissionProvider, principalIdFor, type DaemonAdmissionEvent } from "../server/admission.js";
import { initializeInstance, openKernel } from "../server/init.js";
import { NO_CORE_ENFORCEMENT, PASEO_DAEMON_PERMISSIONS, type CoreEnforcement } from "../server/kernel/index.js";
import { PW, makeHousehold } from "./helpers.js";

const ADMISSION_ONLY: CoreEnforcement = { ...NO_CORE_ENFORCEMENT, principalAdmission: true, pluginCallerIdentity: true };
const FULL: CoreEnforcement = { principalAdmission: true, resourceScopedGrants: true, redactedDaemonRead: true, pluginCallerIdentity: true };

const post = (provider: ReturnType<typeof createKernelAdmissionProvider>, path: string, body: unknown, token?: string, remoteAddress?: string) =>
  provider.http({ method: "POST", path, headers: token ? { authorization: `Bearer ${token}` } : {}, body, ...(remoteAddress ? { remoteAddress } : {}) });
const get = (provider: ReturnType<typeof createKernelAdmissionProvider>, path: string, token?: string) =>
  provider.http({ method: "GET", path, headers: token ? { authorization: `Bearer ${token}` } : {}, body: undefined });

async function tokenFor(provider: ReturnType<typeof createKernelAdmissionProvider>, username: string, password: string) {
  const res = await post(provider, "/login", { username, password }, undefined, "10.0.0.9");
  return res.status === 200 ? (res.body as { token: string }).token : null;
}

describe("kernel-backed admission provider", () => {
  it("admits an administrator with every daemon permission as a per-login-session principal", async () => {
    const { kernel } = await makeHousehold();
    const provider = createKernelAdmissionProvider(kernel, ADMISSION_ONLY);
    const token = await tokenFor(provider, "admin", PW.admin);
    const admitted = await provider.authenticate(token!, { clientId: "c" });
    expect([...admitted!.permissions].sort()).toEqual([...PASEO_DAEMON_PERMISSIONS].sort());
    expect(admitted!.principalId).toMatch(/^user:[\w-]+:[\w-]+$/);
    expect(admitted!.principalId).not.toBe("owner");
  });

  it("does not admit a developer when the daemon cannot scope resources, and says why at login", async () => {
    const { kernel, store, alice, aliceId } = await makeHousehold();
    const provider = createKernelAdmissionProvider(kernel, ADMISSION_ONLY);
    const res = await post(provider, "/login", { username: "alice", password: PW.dev });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "daemon_access_unavailable", blockedBy: ["resourceScopedGrants", "redactedDaemonRead"] });
    // The session created to check this was revoked, so no usable token was left behind.
    const sessions = (await store.read()).sessions.filter((x) => x.userId === aliceId && x.id !== alice.loginSessionId);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.revokedAt).not.toBeNull();
  });

  it("admits a developer with only workspace permissions once the daemon reports scoping", async () => {
    const { kernel } = await makeHousehold();
    const provider = createKernelAdmissionProvider(kernel, FULL);
    const token = await tokenFor(provider, "alice", PW.dev);
    const admitted = await provider.authenticate(token!, { clientId: "c" });
    expect([...admitted!.permissions].sort()).toEqual(["daemon.read", "workspace.manage", "workspace.read", "workspace.write"]);
  });

  it("rejects bad tokens and answers wrong password, unknown user and bad input without leaking which", async () => {
    const { kernel } = await makeHousehold();
    const provider = createKernelAdmissionProvider(kernel, FULL);
    expect(await provider.authenticate("pus_" + "A".repeat(43), { clientId: "c" })).toBeNull();
    expect(await provider.authenticate("", { clientId: "c" })).toBeNull();
    const wrong = await post(provider, "/login", { username: "alice", password: "wrong password here" });
    const unknown = await post(provider, "/login", { username: "nobody", password: "wrong password here" });
    expect(wrong).toEqual(unknown);
    expect(wrong.status).toBe(401);
    expect((await post(provider, "/login", { username: "alice" })).status).toBe(400);
    expect((await post(provider, "/login", "nonsense")).status).toBe(400);
  });

  it("throttles repeated failures with 429", async () => {
    const { kernel } = await makeHousehold();
    const provider = createKernelAdmissionProvider(kernel, FULL);
    let last = 0;
    for (let i = 0; i < 9; i++) last = (await post(provider, "/login", { username: "bob", password: `wrong password ${i}` }, undefined, `10.1.0.${i}`)).status;
    expect(last).toBe(429);
  });

  it("emits a revoke event for exactly the revoked login session, and for every session when a user is disabled", async () => {
    const { kernel, admin, aliceId } = await makeHousehold();
    const provider = createKernelAdmissionProvider(kernel, FULL);
    const events: DaemonAdmissionEvent[] = [];
    provider.subscribe((e) => events.push(e));

    const a = await tokenFor(provider, "alice", PW.dev);
    const b = await tokenFor(provider, "alice", PW.dev);
    const pa = (await kernel.authenticate(a!))!;
    const pb = (await kernel.authenticate(b!))!;
    await kernel.logout(pa);
    expect(events).toEqual([{ principalId: principalIdFor(aliceId, pa.loginSessionId), permissions: null }]);

    events.length = 0;
    await kernel.setUserStatus(admin, aliceId, "disabled");
    expect(events.map((e) => e.principalId)).toContain(principalIdFor(aliceId, pb.loginSessionId));
    expect(events.every((e) => e.permissions === null && e.principalId.startsWith(`user:${aliceId}:`))).toBe(true);
    expect(await provider.authenticate(b!, { clientId: "c" })).toBeNull();
  });
});

describe("first-run initialization", () => {
  it("creates the administrator once, stores files privately, and never keeps the password", async () => {
    const dir = join(await mkdtemp(join(tmpdir(), "pu-init-")), "plugin-data", "paseo-users");
    await initializeInstance(dir, { username: "root", password: "first run passphrase 123" });
    await expect(initializeInstance(dir, { username: "again", password: "second passphrase 4567" })).rejects.toThrow(/Already initialized/);
    const kernel = await openKernel(dir);
    expect(await kernel.isInitialized()).toBe(true);
    expect((await kernel.login({ username: "root", password: "first run passphrase 123" })).ok).toBe(true);
    expect(await readFile(join(dir, "users.json"), "utf8")).not.toContain("first run passphrase");
  });
});

describe("provider-hosted account API", () => {
  async function setup() {
    const h = await makeHousehold();
    const provider = createKernelAdmissionProvider(h.kernel, FULL);
    const admin = (await tokenFor(provider, "admin", PW.admin))!;
    const alice = (await tokenFor(provider, "alice", PW.dev))!;
    return { ...h, provider, admin, alice };
  }

  it("requires a valid bearer token for everything except login", async () => {
    const { provider } = await setup();
    for (const [method, path] of [["GET", "/me"], ["POST", "/logout"], ["GET", "/sessions"], ["POST", "/users"], ["POST", "/users/status"]] as const) {
      expect((await provider.http({ method, path, headers: {}, body: {} })).status).toBe(401);
      expect((await provider.http({ method, path, headers: { authorization: "Bearer pus_" + "A".repeat(43) }, body: {} })).status).toBe(401);
    }
    expect((await get(provider, "/nope")).status).toBe(401);
  });

  it("lets an administrator create a developer who can then sign in; a developer cannot create users", async () => {
    const { provider, admin, alice } = await setup();
    expect((await post(provider, "/users", { username: "carol", roleIds: ["developer"], initialPassword: "a fresh onboarding phrase" }, alice)).status).toBe(403);
    const created = await post(provider, "/users", { username: "carol", roleIds: ["developer"], initialPassword: "a fresh onboarding phrase" }, admin);
    expect(created.status).toBe(201);
    expect((await post(provider, "/login", { username: "carol", password: "a fresh onboarding phrase" })).status).toBe(200);
    expect((await post(provider, "/users", { username: "carol", roleIds: ["developer"], initialPassword: "another onboarding phrase" }, admin)).status).toBe(409);
    expect((await post(provider, "/users", { username: "dave", roleIds: ["developer"], initialPassword: "short" }, admin)).status).toBe(400);
    expect((await post(provider, "/users", { username: "erin", roleIds: ["administrator", "nonexistent"], initialPassword: "a fresh onboarding phrase" }, admin)).status).toBe(400);
    expect((await post(provider, "/users", { username: "X", roleIds: ["developer"], initialPassword: "a fresh onboarding phrase" }, admin)).status).toBe(400);
  });

  it("lets an administrator disable a user and end all of their sessions, observable as revoke events", async () => {
    const { provider, admin, aliceId } = await setup();
    const events: DaemonAdmissionEvent[] = [];
    provider.subscribe((e) => events.push(e));
    const again = (await tokenFor(provider, "alice", PW.dev))!;
    expect((await post(provider, "/users/status", { userId: aliceId, status: "disabled" }, admin)).status).toBe(200);
    expect(events.length).toBeGreaterThan(0);
    expect(await provider.authenticate(again, { clientId: "c" })).toBeNull();
    expect((await post(provider, "/login", { username: "alice", password: PW.dev })).status).toBe(401);
  });

  it("a developer cannot disable or revoke another user, and can revoke only their own device", async () => {
    const { provider, alice, bobId, kernel, bob } = await setup();
    expect((await post(provider, "/users/status", { userId: bobId, status: "disabled" }, alice)).status).toBe(403);
    expect((await post(provider, "/users/revoke-sessions", { userId: bobId }, alice)).status).toBe(403);
    const bobSessions = await kernel.listLoginSessions(bob, bob.userId);
    expect((await post(provider, "/sessions/revoke", { sessionId: bobSessions[0]!.id }, alice)).status).toBe(403);
  });

  it("logout ends the caller's session; /me and /sessions never expose hashes or tokens", async () => {
    const { provider, alice } = await setup();
    const me = await get(provider, "/me", alice);
    expect(me.body).toMatchObject({ username: "alice", roleIds: ["developer"] });
    const sessions = await get(provider, "/sessions", alice);
    expect(JSON.stringify(sessions.body)).not.toMatch(/tokenHash|scrypt|pus_/);
    expect((await post(provider, "/logout", {}, alice)).status).toBe(200);
    expect((await get(provider, "/me", alice)).status).toBe(401);
  });

  it("maps an unexpected kernel failure to a bare 500 that leaks nothing", async () => {
    const { kernel, admin } = await setup();
    const broken = createKernelAdmissionProvider(
      Object.assign(Object.create(kernel), {
        listLoginSessions: async () => {
          throw new Error("disk exploded at /secret/path");
        },
      }),
      FULL,
    );
    const res = await broken.http({ method: "GET", path: "/sessions", headers: { authorization: `Bearer ${admin}` }, body: undefined });
    expect(res).toEqual({ status: 500, body: { error: "internal_error" } });
  });
});
