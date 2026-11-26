import { posix } from "node:path";
import type { Person, ResolvedConfig } from "../config.js";
import type { IsolationStrategy, Step } from "./index.js";
import { healthUrl, renderUnit, unitName } from "./shared.js";

const { join } = posix;

const acct = (p: Person): string => p.unixAccount ?? "";
const accountHome = (p: Person, ctx: ResolvedConfig) => join(ctx.unixAccountHomeBase, acct(p));
const home = (p: Person, ctx: ResolvedConfig) => join(accountHome(p, ctx), ".paseo-daemon");
const envFile = (p: Person, ctx: ResolvedConfig) => join(accountHome(p, ctx), ".paseo-daemon.env");
const optionalEnvFile = (p: Person, ctx: ResolvedConfig) => join(accountHome(p, ctx), ".paseo-provider.env");
const unitDir = (p: Person, ctx: ResolvedConfig) => join(accountHome(p, ctx), ".config", "systemd", "user");
const unitPath = (p: Person, ctx: ResolvedConfig) => join(unitDir(p, ctx), unitName(p.name));
/** Run systemctl against another account's user manager. Works only as root. UNVERIFIED on a real host. */
const userCtl = (p: Person, ...args: string[]) => ["systemctl", `--machine=${acct(p)}@.host`, "--user", ...args];

/**
 * Each person gets their own Linux user (own uid, home, PASEO_HOME). The OS enforces separation.
 * Provider logins are NOT shared: each account needs its own login, or an API key in that daemon's env.
 * Every step here changes the host and needs root.
 */
export const unixAccount: IsolationStrategy = {
  id: "unix-account",

  validate(person) {
    const errors: string[] = [];
    if (!person.unixAccount) errors.push(`${person.name}: isolation "unix-account" requires unixAccount`);
    return errors;
  },

  paseoHome: home,

  plan(person, ctx) {
    const n = person.name;
    const a = acct(person);
    const root = (s: Omit<Step, "privileged">): Step => ({ ...s, privileged: true });
    return [
      root({
        id: `${n}.useradd`,
        description: `Create Linux account ${a} (own uid and home, bash shell)`,
        kind: "command",
        command: ["useradd", "--create-home", "--home-dir", accountHome(person, ctx), "--shell", "/bin/bash", "--user-group", a],
      }),
      root({
        id: `${n}.lock-password`,
        description: `Lock ${a}'s login password (the account only runs the daemon; no password login)`,
        kind: "command",
        command: ["passwd", "-l", a],
      }),
      root({
        id: `${n}.account-home`,
        description: `Account home for ${a} (0700, owned by ${a})`,
        kind: "dir",
        dir: { path: accountHome(person, ctx), mode: "0700", owner: a },
      }),
      root({
        id: `${n}.paseo-home`,
        description: `PASEO_HOME for ${n} (0700, owned by ${a})`,
        kind: "dir",
        dir: { path: home(person, ctx), mode: "0700", owner: a },
      }),
      root({
        id: `${n}.config-dir`,
        description: `${a}'s .config (0700, owned by ${a})`,
        kind: "dir",
        dir: { path: join(accountHome(person, ctx), ".config"), mode: "0700", owner: a },
      }),
      root({
        id: `${n}.systemd-dir`,
        description: `${a}'s .config/systemd (0700, owned by ${a})`,
        kind: "dir",
        dir: { path: join(accountHome(person, ctx), ".config", "systemd"), mode: "0700", owner: a },
      }),
      root({
        id: `${n}.unit-dir`,
        description: `${a}'s systemd user unit directory (0700, owned by ${a})`,
        kind: "dir",
        dir: { path: unitDir(person, ctx), mode: "0700", owner: a },
      }),
      root({
        id: `${n}.secret-env`,
        description: `Install ${n}'s daemon password as an EnvironmentFile (0600, owned by ${a}, plaintext at rest)`,
        kind: "file",
        file: { path: envFile(person, ctx), mode: "0600", owner: a, secretRef: n },
      }),
      root({
        id: `${n}.unit`,
        description: `Install the systemd user unit for ${n} under ${a}'s home (owned by ${a})`,
        kind: "file",
        file: {
          path: unitPath(person, ctx),
          mode: "0644",
          owner: a,
          content: renderUnit({
            name: n,
            paseoHome: home(person, ctx),
            listen: `${ctx.listenAddress}:${person.port}`,
            paseoBinary: ctx.paseoBinary,
            envFile: envFile(person, ctx),
            optionalEnvFile: optionalEnvFile(person, ctx),
          }),
        },
      }),
      root({
        id: `${n}.linger`,
        description: `Start ${a}'s user manager now and at boot`,
        kind: "command",
        command: ["loginctl", "enable-linger", a],
      }),
      root({
        id: `${n}.daemon-reload`,
        description: `Reload ${a}'s user manager`,
        kind: "command",
        command: userCtl(person, "daemon-reload"),
      }),
      root({
        id: `${n}.enable`,
        description: `Enable and start ${unitName(n)} for ${a}`,
        kind: "command",
        command: userCtl(person, "enable", "--now", unitName(n)),
      }),
      {
        id: `${n}.llm-login`,
        description:
          `MANUAL: LLM logins are NOT shared. Log each provider CLI in as ${a} (for example: sudo -iu ${a}), or put an API key ` +
          `in ${optionalEnvFile(person, ctx)} (0600, owned by ${a}; the unit reads it if present). Which variables each provider reads is UNVERIFIED.`,
        kind: "manual",
      },
    ];
  },

  revoke(person, ctx) {
    const n = person.name;
    const a = acct(person);
    return [
      {
        id: `${n}.disable`,
        description: `Stop and disable ${unitName(n)} for ${a}`,
        kind: "command",
        command: userCtl(person, "disable", "--now", unitName(n)),
        privileged: true,
      },
      {
        id: `${n}.secret-env`,
        description: `Install a ROTATED password for ${n} (0600, owned by ${a})`,
        kind: "file",
        file: { path: envFile(person, ctx), mode: "0600", owner: a, secretRef: n },
        privileged: true,
      },
      {
        id: `${n}.lock-account`,
        description: `Lock account ${a}`,
        kind: "command",
        command: ["usermod", "-L", a],
        privileged: true,
      },
      {
        id: `${n}.terminate`,
        description: `End every remaining process of ${a} (agents the daemon started)`,
        kind: "command",
        command: ["loginctl", "terminate-user", a],
        privileged: true,
      },
      {
        id: `${n}.revoke-note`,
        description: `MANUAL: ${accountHome(person, ctx)} is kept. Remove it yourself when you are sure nothing is needed.`,
        kind: "manual",
      },
    ];
  },

  verify(person, others, ctx) {
    const a = acct(person);
    const steps: Step[] = [
      {
        id: `${person.name}.verify-health`,
        description: `Daemon for ${person.name} answers on its own port (health endpoint)`,
        kind: "command",
        command: ["curl", "-fsS", "--max-time", "5", healthUrl(person, ctx)],
      },
    ];
    for (const other of others) {
      if (other.isolation === "unix-account") {
        steps.push({
          id: `${person.name}.${other.name}.verify-unreadable`,
          description: `${other.unixAccount} cannot read ${person.name}'s PASEO_HOME`,
          kind: "command",
          command: ["sudo", "-u", acct(other), "test", "!", "-r", home(person, ctx)],
          privileged: true,
        });
      } else if (other.isolation === "same-user") {
        steps.push({
          id: `${person.name}.${other.name}.verify-unreadable-from-account`,
          description: `${a} cannot read ${other.name}'s PASEO_HOME (same-user daemon)`,
          kind: "command",
          command: ["sudo", "-u", a, "test", "!", "-r", join(ctx.homeBase, other.name)],
          privileged: true,
        });
      }
    }
    steps.push({
      id: `${person.name}.verify-app`,
      description:
        `MANUAL: confirm ${person.name} added their daemon as a separate host in the app and that providers work ` +
        `after the separate login (UNVERIFIED).`,
      kind: "manual",
    });
    return steps;
  },
};
