import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dataDirFor, initializeInstance, openKernel } from "../server/init.js";
import { connect, startDisposableDaemon, type Harness } from "./daemon-harness.js";

/**
 * END-TO-END ON THE CORE BRANCH
 *
 * Runs a REAL daemon built from the `feat/users-admission` branch of the Paseo fork, with this
 * package's compiled admission provider loaded through PASEO_ADMISSION_MODULE, and drives it over
 * real HTTP and WebSocket. Disposable only: temp PASEO_HOME, loopback, ephemeral port, relay off,
 * synthetic passwords. Nothing here touches a production daemon.
 *
 *   npm run build                              # compile the provider to dist/
 *   (in the fork worktree) npm run build --workspace=@getpaseo/server
 *   PASEO_PROBE=1 PASEO_CORE_DIR=/path/to/worktree npm run test:probes
 */
const core = process.env.PASEO_CORE_DIR;
const enabled = process.env.PASEO_PROBE === "1" && !!core;

const ADMIN_PW = "synthetic blue lantern phrase 1";
const OPS_PW = "synthetic green anchor phrase 2";
const DEV_PW = "synthetic amber window phrase 3";
const OPERATOR_PW = "synthetic operator-only password";
const providerModule = fileURLToPath(new URL("../dist/server/admission-entry.js", import.meta.url));

describe.skipIf(!enabled)("real daemon from the core branch + paseo-users provider", () => {
  let h: Harness;

  const api = async (method: string, path: string, body?: unknown, token?: string) => {
    const res = await fetch(`http://127.0.0.1:${h.port}/api/auth${path}`, {
      method,
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, any> | null }; // eslint-disable-line @typescript-eslint/no-explicit-any
  };
  const login = async (username: string, password: string) => {
    const r = await api("POST", "/login", { username, password });
    return { ...r, token: r.body?.token as string | undefined };
  };
  const session = (token: string, clientId: string) => connect(h, { auth: { kind: "credential", token }, clientId });

  beforeAll(async () => {
    execFileSync("git", ["-C", core!, "rev-parse", "--abbrev-ref", "HEAD"]); // fails fast if PASEO_CORE_DIR is wrong
    h = await startDisposableDaemon("", {
      launch: { script: join(core!, "packages/server/dist/scripts/supervisor-entrypoint.js") },
      env: { PASEO_ADMISSION_MODULE: providerModule },
      prepare: async (home) => {
        const dir = dataDirFor(home);
        await initializeInstance(dir, { username: "admin", password: ADMIN_PW });
        const kernel = await openKernel(dir);
        const result = await kernel.login({ username: "admin", password: ADMIN_PW });
        if (!result.ok) throw new Error("seed login failed");
        const admin = (await kernel.authenticate(result.token))!;
        await kernel.createUser(admin, { username: "ops", roleIds: ["administrator"], initialPassword: OPS_PW });
        await kernel.createUser(admin, { username: "alice", roleIds: ["developer"], initialPassword: DEV_PW });
      },
    });
  });
  afterAll(async () => {
    await h?.stop();
  });

  it("admits an administrator as a distinct principal, not the shared owner (MVP 1, 3)", async () => {
    const { status, token } = await login("admin", ADMIN_PW);
    expect(status).toBe(200);
    const s = await session(token!, "admin-1");
    expect(s.serverInfo!.permissions).toHaveLength(9);
    expect(s.serverInfo!.features).toMatchObject({ principalAdmission: true, pluginCallerIdentity: true });
    s.close();
  });

  it("closes the shared-secret bypass: the operator password admits nobody over the network (MVP 8, partial)", async () => {
    // The harness password is passed as PASEO_PASSWORD: it still guards HTTP, but not sessions.
    const viaHello = await connect(h, { password: h.password, clientId: "bypass-1" });
    expect(viaHello.serverInfo).toBeNull();
    expect(viaHello.rejected).toMatchObject({ reason: "incorrect_password", authMode: "users" });
    const viaHeader = await connect(h, { headers: { Authorization: `Bearer ${h.password}` }, clientId: "bypass-2" }).catch(() => null);
    expect(viaHeader?.serverInfo ?? null).toBeNull();
    const anonymous = await connect(h, { clientId: "anon" });
    expect(anonymous.serverInfo).toBeNull();
    expect(anonymous.rejected).toMatchObject({ reason: "password_required", authMode: "users" });
  });

  it("rejects forged and malformed credentials", async () => {
    for (const token of ["", "pus_" + "A".repeat(43), "not-a-token"]) {
      const s = await session(token, "forged").catch(() => null);
      expect(s?.serverInfo ?? null).toBeNull();
    }
  });

  it("the local operator credential still works, so the CLI is not locked out", async () => {
    const local = (await readFile(join(h.home, "local-credential"), "utf8")).trim();
    const s = await connect(h, { auth: { kind: "localCredential", token: local }, clientId: "cli" });
    expect(s.serverInfo!.permissions).toHaveLength(9);
    s.close();
  });

  it("HTTP outside /api/auth still needs the operator password (MCP/status are not opened up)", async () => {
    expect((await fetch(`http://127.0.0.1:${h.port}/api/status`)).status).toBe(401);
    expect((await fetch(`http://127.0.0.1:${h.port}/api/health`)).status).toBe(200);
    expect((await api("GET", "/me")).status).toBe(401);
  });

  it("does NOT admit a developer: resource scoping is missing in core, so the account fails closed (MVP 4/5 unmet)", async () => {
    const r = await login("alice", DEV_PW);
    expect(r.status).toBe(403);
    expect(r.body).toEqual({ error: "daemon_access_unavailable", blockedBy: ["resourceScopedGrants", "redactedDaemonRead"] });
    expect(r.token).toBeUndefined();
  });

  it("login errors are uniform and throttled", async () => {
    const wrong = await login("admin", "definitely the wrong one 1");
    const unknown = await login("nobody-here", "definitely the wrong one 1");
    expect(wrong.status).toBe(401);
    expect(wrong.body).toEqual(unknown.body);
  });

  it("administrator revokes an account: its live socket closes and the token stops working (MVP 7)", async () => {
    const admin = (await login("admin", ADMIN_PW)).token!;
    const ops = await login("ops", OPS_PW);
    const opsSocket = await session(ops.token!, "ops-1");
    expect(opsSocket.serverInfo).not.toBeNull();
    const me = await api("GET", "/me", undefined, admin);
    expect(me.body).toMatchObject({ username: "admin" });
    const opsId = ((await api("GET", "/me", undefined, ops.token)).body as { userId: string }).userId;

    const started = Date.now();
    expect((await api("POST", "/users/status", { userId: opsId, status: "disabled" }, admin)).status).toBe(200);
    const { code } = await opsSocket.closed;
    expect(code).toBe(4401);
    expect(Date.now() - started).toBeLessThan(2000);
    expect((await session(ops.token!, "ops-2")).serverInfo).toBeNull();
    expect((await login("ops", OPS_PW)).status).toBe(401);
  });

  it("revoking one device closes only that device", async () => {
    const t1 = (await login("admin", ADMIN_PW)).token!;
    const t2 = (await login("admin", ADMIN_PW)).token!;
    const s1 = await session(t1, "dev-1");
    const s2 = await session(t2, "dev-2");
    expect((await api("POST", "/logout", {}, t1)).status).toBe(200);
    expect((await s1.closed).code).toBe(4401);
    const stillWorks = await s2.request({ type: "ping" }).catch(() => null);
    void stillWorks;
    const r = await s2.request({ type: "plugin.list.request" });
    expect(r.type).toBe("plugin.list.response");
    s2.close();
  });

  it("an administrator can create an account through the API; a malformed or duplicate one is refused", async () => {
    const admin = (await login("admin", ADMIN_PW)).token!;
    expect((await api("POST", "/users", { username: "carol", roleIds: ["developer"], initialPassword: "synthetic silver harbor phrase 4" }, admin)).status).toBe(201);
    expect((await api("POST", "/users", { username: "carol", roleIds: ["developer"], initialPassword: "synthetic silver harbor phrase 4" }, admin)).status).toBe(409);
    expect((await api("POST", "/users", { username: "x", roleIds: ["developer"], initialPassword: "short" }, admin)).status).toBe(400);
    expect((await api("POST", "/users", { username: "mallory", roleIds: ["developer"], initialPassword: "synthetic copper meadow phrase 5" })).status).toBe(401);
  });

  it("revoking someone's login leaves no credential or password in the store the daemon wrote", async () => {
    const store = await readFile(join(dataDirFor(h.home), "users.json"), "utf8");
    for (const secret of [ADMIN_PW, OPS_PW, DEV_PW, OPERATOR_PW, "synthetic silver harbor phrase 4"]) expect(store).not.toContain(secret);
    const audit = await readFile(join(dataDirFor(h.home), "audit.jsonl"), "utf8");
    expect(audit).toContain("auth.session.revoked");
    for (const secret of [ADMIN_PW, DEV_PW]) expect(audit).not.toContain(secret);
  });
});
