import { posix } from "node:path";
import type { Person, ResolvedConfig } from "../config.js";
import type { IsolationStrategy, Step } from "./index.js";
import { healthUrl, renderUnit, unitName } from "./shared.js";

const { join } = posix;

const home = (p: Person, ctx: ResolvedConfig) => join(ctx.homeBase, p.name);
const envFile = (p: Person, ctx: ResolvedConfig) => join(ctx.homeBase, `${p.name}.env`);
const unitDir = (ctx: ResolvedConfig) => join(ctx.userHome, ".config", "systemd", "user");
const unitPath = (p: Person, ctx: ResolvedConfig) => join(unitDir(ctx), unitName(p.name));

/**
 * All daemons run as the CURRENT Linux user. Separation is by data only: separate PASEO_HOME, project registry,
 * agents, password, port. Agents of one daemon can read the files of every other (same uid). Not OS isolation.
 * Provider CLIs keep using the user's own home, so LLM logins are shared (UNVERIFIED per provider).
 */
export const sameUser: IsolationStrategy = {
  id: "same-user",

  validate(person, ctx) {
    const errors: string[] = [];
    if (person.unixAccount) errors.push(`${person.name}: unixAccount is ignored by same-user; remove it or use isolation "unix-account"`);
    if (ctx.homeBase === ctx.userHome) errors.push(`${person.name}: homeBase must not be userHome itself`);
    return errors;
  },

  paseoHome: home,

  plan(person, ctx) {
    const n = person.name;
    const steps: Step[] = [
      {
        id: "same-user.homebase",
        description: `Create ${ctx.homeBase} (0700), parent of every person's PASEO_HOME`,
        kind: "dir",
        dir: { path: ctx.homeBase, mode: "0700" },
      },
      {
        id: `${n}.paseo-home`,
        description: `Create PASEO_HOME for ${n} (0700). Never the default ~/.paseo.`,
        kind: "dir",
        dir: { path: home(person, ctx), mode: "0700" },
      },
      {
        id: `${n}.secret-env`,
        description: `Install ${n}'s daemon password as an EnvironmentFile (0600, plaintext at rest)`,
        kind: "file",
        file: { path: envFile(person, ctx), mode: "0600", secretRef: n },
      },
      {
        id: "same-user.unit-dir",
        description: `Create the systemd user unit directory ${unitDir(ctx)}`,
        kind: "command",
        command: ["mkdir", "-p", unitDir(ctx)],
      },
      {
        id: `${n}.unit`,
        description: `Install the systemd user unit for ${n}`,
        kind: "file",
        file: {
          path: unitPath(person, ctx),
          mode: "0644",
          content: renderUnit({
            name: n,
            paseoHome: home(person, ctx),
            listen: `${ctx.listenAddress}:${person.port}`,
            paseoBinary: ctx.paseoBinary,
            envFile: envFile(person, ctx),
            ...(ctx.environmentPath ? { environmentPath: ctx.environmentPath } : {}),
          }),
        },
      },
      {
        id: `${n}.daemon-reload`,
        description: "Reload the user manager",
        kind: "command",
        command: ["systemctl", "--user", "daemon-reload"],
        privileged: false,
      },
      {
        id: `${n}.enable`,
        description: `Enable and start ${unitName(n)}`,
        kind: "command",
        command: ["systemctl", "--user", "enable", "--now", unitName(n)],
        privileged: false,
      },
      {
        id: "same-user.linger",
        description:
          'MANUAL, needs root: so the daemons survive logout and start at boot, run: loginctl enable-linger "$(id -un)"',
        kind: "manual",
        privileged: true,
      },
    ];
    return steps;
  },

  revoke(person, ctx) {
    const n = person.name;
    return [
      {
        id: `${n}.disable`,
        description: `Stop and disable ${unitName(n)}`,
        kind: "command",
        command: ["systemctl", "--user", "disable", "--now", unitName(n)],
        privileged: false,
      },
      {
        id: `${n}.secret-env`,
        description: `Install a ROTATED password for ${n} (the old one stops working if the unit is ever started again)`,
        kind: "file",
        file: { path: envFile(person, ctx), mode: "0600", secretRef: n },
      },
      {
        id: `${n}.revoke-note`,
        description:
          "MANUAL: same-user mode cannot stop a revoked person's agents from reading your files while they had access, " +
          "and stopping the unit may not end every process an agent started. Check with: ps -u \"$(id -un)\". " +
          "Their data stays in " + home(person, ctx) + " until you remove it.",
        kind: "manual",
      },
    ];
  },

  verify(person, others, ctx) {
    const steps: Step[] = [
      {
        id: `${person.name}.verify-health`,
        description: `Daemon for ${person.name} answers on its own port (health endpoint)`,
        kind: "command",
        command: ["curl", "-fsS", "--max-time", "5", healthUrl(person, ctx)],
      },
    ];
    for (const other of others) {
      if (other.isolation !== "same-user" || other.name < person.name) continue;
      steps.push({
        id: `${person.name}.${other.name}.verify-distinct-homes`,
        description:
          `Confirm the PASEO_HOME of ${person.name} and ${other.name} differ and the ports differ: ` +
          `${home(person, ctx)}:${person.port} vs ${home(other, ctx)}:${other.port}`,
        kind: "command",
        command: [
          "grep",
          "-H",
          "-e",
          "^Environment=PASEO_HOME=",
          "-e",
          "^Environment=PASEO_LISTEN=",
          unitPath(person, ctx),
          unitPath(other, ctx),
        ],
      });
    }
    steps.push({
      id: `${person.name}.verify-app`,
      description:
        `MANUAL: confirm ${person.name} added their daemon as a separate host in the app, and that provider logins ` +
        "(Claude, Codex, ...) work from that daemon without logging in again. Both are UNVERIFIED.",
      kind: "manual",
    });
    return steps;
  },
};
