import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connect, startDisposableDaemon, type Harness } from "./daemon-harness.js";

/**
 * Installs THIS plugin into a disposable daemon and checks it loads under Paseo's real plugin
 * compiler and answers its one RPC. Opt in with PASEO_PROBE=1 (same safety rules as blockers.probe.ts).
 */
const enabled = process.env.PASEO_PROBE === "1";
const cli = () =>
  process.env.PASEO_PROBE_CLI ?? execFileSync("realpath", [execFileSync("which", ["paseo"], { encoding: "utf8" }).trim()], { encoding: "utf8" }).trim();

describe.skipIf(!enabled)("plugin loads in a real daemon", () => {
  let harness: Harness;
  beforeAll(async () => {
    harness = await startDisposableDaemon(cli(), {
      config: { pluginsEnabled: true, plugins: { "paseo-users": { source: "directory", path: process.cwd(), enabled: true } } },
    });
  });
  afterAll(async () => { await harness?.stop(); });

  it("is listed and serves users.status.get, reporting that nothing is enforced", async () => {
    const operator = await connect(harness, { password: harness.password, clientId: "operator" });
    const listed = await operator.request({ type: "plugin.list.request" });
    expect(JSON.stringify(listed)).toContain("paseo-users");
    const status = await operator.request({ type: "plugin.rpc.invoke.request", pluginId: "paseo-users", method: "users.status.get", input: {} });
    expect(status).toMatchObject({
      type: "plugin.rpc.invoke.response",
      payload: { output: { plugin: "paseo-users", enforcement: "none", contractVersion: 1 } },
    });
    operator.close();
  });

  it("a non-operator session cannot call the plugin's RPC", async () => {
    const dev = await connect(harness, { password: harness.password, clientId: "dev", sessionPermissions: ["workspace.read", "workspace.write"] });
    const r = await dev.request({ type: "plugin.rpc.invoke.request", pluginId: "paseo-users", method: "users.status.get", input: {} });
    expect(r).toMatchObject({ type: "rpc_error", payload: { code: "access_denied" } });
    dev.close();
  });

  it("the plugin registers no account-mutating RPC", async () => {
    const operator = await connect(harness, { password: harness.password, clientId: "operator-2" });
    for (const method of ["users.create", "users.login", "users.list", "users.revoke"]) {
      const r = await operator.request({ type: "plugin.rpc.invoke.request", pluginId: "paseo-users", method, input: {} }).catch((e: Error) => ({ type: "error", message: e.message }));
      expect(r.type).not.toBe("plugin.rpc.invoke.response");
    }
    operator.close();
  });
});
