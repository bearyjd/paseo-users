import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connect, startDisposableDaemon, type Harness } from "./daemon-harness.js";

/**
 * BLOCKER VERIFICATION PROBES
 *
 * These run against a disposable daemon and assert what CURRENT upstream Paseo does. They pass
 * while the blockers documented in docs/02-sdk-capability-matrix.md exist. When the core
 * extension lands, the "blocker" assertions are expected to FAIL and must be replaced by the
 * acceptance tests in docs/10-testing-and-acceptance.md. A failing probe is therefore a signal
 * to update the docs, not a regression.
 *
 * Opt in with PASEO_PROBE=1. The CLI is taken from PASEO_PROBE_CLI or `paseo` on PATH.
 */
const enabled = process.env.PASEO_PROBE === "1";

function resolveCli(): string {
  if (process.env.PASEO_PROBE_CLI) return process.env.PASEO_PROBE_CLI;
  const bin = execFileSync("which", ["paseo"], { encoding: "utf8" }).trim();
  return execFileSync("realpath", [bin], { encoding: "utf8" }).trim();
}

describe.skipIf(!enabled)("current upstream behaviour (disposable daemon)", () => {
  let harness: Harness;
  let workdir: string;

  beforeAll(async () => {
    harness = await startDisposableDaemon(resolveCli());
    workdir = await realpath(await mkdtemp(join(tmpdir(), "paseo-users-probe-work-")));
  });
  afterAll(async () => {
    await harness?.stop();
    if (workdir) await rm(workdir, { recursive: true, force: true });
  });

  it("baseline: no password, or a wrong one, is never admitted", async () => {
    // Without hello.auth upstream closes the socket silently (the rejection frame is only sent to
    // clients that supply auth or advertise the capability); either way no session is admitted.
    const anonymous = await connect(harness, { clientId: "anon" }).catch(() => null);
    expect(anonymous?.serverInfo ?? null).toBeNull();
    anonymous?.close();
    const wrong = await connect(harness, { password: "not-the-password", clientId: "wrong" });
    expect(wrong.serverInfo).toBeNull();
    expect(wrong.rejected).toMatchObject({ type: "hello.rejected", reason: "incorrect_password" });
    wrong.close();
  });

  it("BLOCKER: every password holder is the same principal with every daemon permission", async () => {
    const a = await connect(harness, { password: harness.password, clientId: "user-a" });
    const b = await connect(harness, { password: harness.password, clientId: "user-b" });
    const expected = ["daemon.read", "daemon.manage", "tunnel.manage", "access.manage", "workspace.read", "workspace.write", "workspace.manage", "automation.manage", "hub.execute"];
    expect([...a.serverInfo!.permissions].sort()).toEqual([...expected].sort());
    expect([...b.serverInfo!.permissions].sort()).toEqual([...expected].sort());
    a.close(); b.close();
  });

  it("BLOCKER: there is no per-user resource boundary - one session's project is visible to another", async () => {
    const a = await connect(harness, { password: harness.password, clientId: "user-a" });
    const b = await connect(harness, { password: harness.password, clientId: "user-b" });
    await mkdir(join(workdir, "alice-private"));
    const added = await a.request({ type: "project.add.request", cwd: join(workdir, "alice-private") });
    expect(added.type).toBe("project.add.response");
    const seen = await b.request({ type: "project.list.request" });
    expect(JSON.stringify(seen)).toContain("alice-private");
    a.close(); b.close();
  });

  it("BLOCKER: file access accepts any directory, not only registered projects", async () => {
    const unregistered = join(workdir, "never-registered");
    await mkdir(unregistered);
    await writeFile(join(unregistered, "canary.txt"), "synthetic canary");
    const s = await connect(harness, { password: harness.password, clientId: "user-b" });
    const listing = await s.request({ type: "file_explorer_request", cwd: unregistered, path: ".", mode: "list" });
    expect(JSON.stringify(listing)).toContain("canary.txt");
    s.close();
  });

  it("works today: a session can attenuate itself, but the CLIENT chooses the ceiling", async () => {
    const narrow = await connect(harness, { password: harness.password, clientId: "narrow", sessionPermissions: ["workspace.read"] });
    expect(narrow.serverInfo!.permissions).toEqual(["workspace.read"]);
    const denied = await narrow.request({ type: "plugin.list.request" });
    expect(denied).toMatchObject({ type: "rpc_error", payload: { code: "access_denied" } });
    const deniedWrite = await narrow.request({ type: "project.add.request", cwd: workdir });
    expect(deniedWrite).toMatchObject({ type: "rpc_error", payload: { code: "access_denied" } });
    narrow.close();
    // The same password can simply reconnect without the ceiling, so this is a convenience, not a boundary.
    const full = await connect(harness, { password: harness.password, clientId: "narrow-2" });
    expect(full.serverInfo!.permissions).toContain("daemon.manage");
    full.close();
  });

  it("works today: plugin management and plugin RPC require daemon.manage", async () => {
    const dev = await connect(harness, { password: harness.password, clientId: "dev", sessionPermissions: ["workspace.read", "workspace.write", "workspace.manage"] });
    for (const type of ["plugin.list.request", "plugin.reload.request", "plugin.rpc.invoke.request"]) {
      const r = await dev.request({ type, pluginId: "x", method: "x", input: {} });
      expect(r).toMatchObject({ type: "rpc_error", payload: { code: "access_denied" } });
    }
    dev.close();
  });
});

describe("plugin SDK caller identity (static, no daemon needed)", () => {
  it("BLOCKER: PluginHandlerContext exposes no caller identity in the pinned SDK", async () => {
    const root = join(process.cwd(), "node_modules/@getpaseo/plugin");
    const dts = await readFile(join(root, "dist/server/contracts.d.ts"), "utf8");
    const block = /interface PluginHandlerContext \{([^}]*)\}/.exec(dts);
    expect(block).not.toBeNull();
    const members = [...(block![1] ?? "").matchAll(/^\s*(\w+)\??:/gm)].map((m) => m[1]);
    expect(members).toEqual(["paseo"]); // no principal, user, session or client id
  });
});
