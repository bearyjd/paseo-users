import type { PluginServerContext } from "@getpaseo/plugin/server";
import { readStatus } from "./server/status.js";
import { statusRpc } from "./shared/status.js";

/**
 * Pre-release entry. It registers one read-only RPC and nothing that mutates accounts: plugin RPC
 * handlers receive no caller identity (PluginHandlerContext is `{ paseo }`), and any session
 * holding daemon.manage can invoke them, so an account-management RPC here would be an
 * operator-only door dressed up as an admin API. The identity kernel in server/kernel is wired in
 * once the daemon can tell the plugin who is calling.
 */
export default function contribute(server: PluginServerContext) {
  server.handle(statusRpc, () => readStatus());
  return () => {};
}
