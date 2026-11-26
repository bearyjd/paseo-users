import type { Person, ResolvedConfig } from "../config.js";

/** URL for the health check. An all-interfaces listen address is probed through loopback. */
export function healthUrl(person: Person, ctx: ResolvedConfig): string {
  const host = ["0.0.0.0", "::", "[::]"].includes(ctx.listenAddress) ? "127.0.0.1" : ctx.listenAddress;
  return `http://${host}:${person.port}/api/health`;
}

export interface UnitInput {
  name: string;
  paseoHome: string;
  listen: string;
  paseoBinary: string;
  envFile: string;
  /** Optional extra EnvironmentFile (prefixed with "-" so a missing file is fine). */
  optionalEnvFile?: string;
}

/**
 * systemd USER unit. The password is read from EnvironmentFile; it never appears in the unit.
 * No ProtectHome: provider CLIs need to read the user's home for their logins.
 * Whether these hardening directives take effect inside a user manager is UNVERIFIED (docs/11).
 */
export function renderUnit(i: UnitInput): string {
  const lines = [
    "[Unit]",
    `Description=Paseo daemon for ${i.name}`,
    "After=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    `Environment=PASEO_HOME=${i.paseoHome}`,
    `Environment=PASEO_LISTEN=${i.listen}`,
    "Environment=PASEO_RELAY_ENABLED=false",
    `EnvironmentFile=${i.envFile}`,
  ];
  if (i.optionalEnvFile) lines.push(`EnvironmentFile=-${i.optionalEnvFile}`);
  lines.push(
    `ExecStart=${i.paseoBinary} daemon run --home ${i.paseoHome}`,
    "Restart=on-failure",
    "RestartSec=5",
    "NoNewPrivileges=yes",
    "PrivateTmp=yes",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  );
  return lines.join("\n");
}

export function unitName(name: string): string {
  return `paseo-${name}.service`;
}
