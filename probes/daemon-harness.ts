import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";

/**
 * Disposable Paseo daemon for verification probes.
 *
 * Safety rules (enforced, not advisory):
 *  - state lives in a fresh temp PASEO_HOME; the real ~/.paseo is never read or written;
 *  - listens on 127.0.0.1 on an OS-assigned high port, never 6767; relay disabled;
 *  - synthetic password only; no agents or providers are created;
 *  - teardown kills only the process group this harness spawned. `paseo daemon stop` is never run.
 */
export interface Harness {
  home: string;
  port: number;
  password: string;
  stop(): Promise<void>;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => (address && typeof address === "object" ? resolve(address.port) : reject(new Error("no port"))));
    });
  });
}

export async function startDisposableDaemon(cli: string, options: { config?: Record<string, unknown> } = {}): Promise<Harness> {
  const home = await realpath(await mkdtemp(join(tmpdir(), "paseo-users-probe-")));
  const port = await freePort();
  if (port === 6767 || port < 1024) throw new Error(`refusing unsafe probe port ${port}`);
  if (options.config) await writeFile(join(home, "config.json"), JSON.stringify(options.config), { mode: 0o600 });
  const password = `probe-${Math.random().toString(36).slice(2)}-synthetic`;
  const child: ChildProcess = spawn(process.execPath, [cli, "daemon", "run", "--home", home], {
    detached: true, // own process group so teardown cannot touch anything else
    stdio: "ignore",
    env: {
      PATH: process.env.PATH,
      HOME: home, // keeps provider/CLI config lookups inside the sandbox directory
      PASEO_HOME: home,
      PASEO_LISTEN: `127.0.0.1:${port}`,
      PASEO_PASSWORD: password,
      PASEO_RELAY_ENABLED: "false",
    },
  });
  const pid = child.pid;
  if (!pid) throw new Error("daemon did not spawn");
  const stop = async () => {
    try { process.kill(-pid, "SIGTERM"); } catch { /* already gone */ }
    await new Promise((r) => setTimeout(r, 1500));
    try { process.kill(-pid, "SIGKILL"); } catch { /* already gone */ }
    await rm(home, { recursive: true, force: true });
  };
  try {
    const deadline = Date.now() + 60_000;
    for (;;) {
      if (Date.now() > deadline) throw new Error("disposable daemon did not become ready");
      try {
        const lock = JSON.parse(await readFile(join(home, "paseo.pid"), "utf8")) as { listen?: string };
        if (lock.listen === `127.0.0.1:${port}`) {
          const res = await fetch(`http://127.0.0.1:${port}/api/health`).catch(() => null);
          if (res?.ok) break;
        }
      } catch { /* not ready */ }
      await new Promise((r) => setTimeout(r, 300));
    }
  } catch (error) {
    await stop();
    throw error;
  }
  return { home, port, password, stop };
}

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export interface ProbeSession {
  serverInfo: Json | null;
  rejected: Json | null;
  request(message: Json): Promise<Json>;
  close(): void;
}

let counter = 0;

export async function connect(
  harness: Harness,
  options: { password?: string | null; clientId: string; sessionPermissions?: string[] },
): Promise<ProbeSession> {
  const ws = new WebSocket(`ws://127.0.0.1:${harness.port}/ws`);
  await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
  const waiters = new Map<string, (m: Json) => void>();
  let serverInfo: Json | null = null;
  let rejected: Json | null = null;
  let settle: () => void = () => undefined;
  const settled = new Promise<void>((r) => { settle = r; });
  ws.on("message", (raw, isBinary) => {
    if (isBinary) return;
    const frame = JSON.parse(raw.toString()) as Json;
    if (frame.type === "hello.rejected") { rejected = frame; settle(); return; }
    if (frame.type !== "session") return;
    const message = frame.message as Json;
    if (message.type === "status" && message.payload?.status === "server_info") { serverInfo = message.payload; settle(); return; }
    const id = message.payload?.requestId;
    if (typeof id === "string") waiters.get(id)?.(message);
  });
  ws.on("close", () => settle());
  ws.send(JSON.stringify({
    type: "hello",
    clientId: options.clientId,
    clientType: "cli",
    protocolVersion: 1,
    ...(options.password ? { auth: { kind: "password", password: options.password } } : {}),
    ...(options.sessionPermissions ? { sessionPermissions: options.sessionPermissions } : {}),
  }));
  await Promise.race([settled, new Promise((_, rej) => setTimeout(() => rej(new Error("hello timed out")), 15_000))]);
  return {
    get serverInfo() { return serverInfo; },
    get rejected() { return rejected; },
    request(message) {
      const requestId = `probe-${++counter}`;
      return new Promise<Json>((resolve, reject) => {
        const timer = setTimeout(() => { waiters.delete(requestId); reject(new Error(`timeout: ${message.type}`)); }, 20_000);
        waiters.set(requestId, (m) => { clearTimeout(timer); waiters.delete(requestId); resolve(m); });
        ws.send(JSON.stringify({ type: "session", message: { ...message, requestId } }));
      });
    },
    close() { ws.close(); },
  };
}
