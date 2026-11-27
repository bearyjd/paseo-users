import { posix } from "node:path";
import type { Person, ResolvedConfig } from "../config.js";
import type { IsolationStrategy, Step } from "./index.js";
import { getProvider } from "../providers.js";
import { healthUrl, renderUnit, unitName } from "./shared.js";

const { join } = posix;

const acct = (p: Person): string => p.unixAccount ?? "";
const accountHome = (p: Person, ctx: ResolvedConfig) => join(ctx.unixAccountHomeBase, acct(p));
const home = (p: Person, ctx: ResolvedConfig) => join(accountHome(p, ctx), ".paseo-daemon");
const envFile = (p: Person, ctx: ResolvedConfig) => join(accountHome(p, ctx), ".paseo-daemon.env");
const optionalEnvFile = (p: Person, ctx: ResolvedConfig) => join(accountHome(p, ctx), ".paseo-provider.env");
const unitDir = (p: Person, ctx: ResolvedConfig) => join(accountHome(p, ctx), ".config", "systemd", "user");
const unitPath = (p: Person, ctx: ResolvedConfig) => join(unitDir(p, ctx), unitName(p.name));
/** The account's own npm prefix and the binaries in it (separate installs only). */
const npmPrefix = (p: Person, ctx: ResolvedConfig) => join(accountHome(p, ctx), ".local", "npm");
const npmBin = (p: Person, ctx: ResolvedConfig) => join(npmPrefix(p, ctx), "bin");
/** Fixed system PATH for account-level commands and the unit. Never derived from the operator's environment. */
const SYSTEM_PATH = "/usr/local/bin:/usr/bin:/bin";
/**
 * Run a command as the account, with its own HOME and a fixed PATH and nothing else: `env -i` drops every inherited
 * variable (npm tokens, API keys, NPM_CONFIG_*, NODE_OPTIONS, LD_PRELOAD) that the root apply process might carry.
 * Shaped for a privileged step: apply runs it as root, runuser drops to the account. UNVERIFIED on a real host.
 */
const asAccount = (p: Person, ctx: ResolvedConfig, ...argv: string[]) => [
  "runuser", "-u", acct(p), "--", "env", "-i", `HOME=${accountHome(p, ctx)}`, `PATH=${SYSTEM_PATH}`, ...argv,
];
const isSeparate = (p: Person) => p.install === "separate";
/** Whether `child` is `parent` or below it, by whole path segments. */
const inside = (parent: string, child: string) => {
  const rel = posix.relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith("../") && !posix.isAbsolute(rel));
};
/** The paseo binary the unit runs: the account's own for a separate install, the host's otherwise. */
const daemonBinary = (p: Person, ctx: ResolvedConfig) => (isSeparate(p) ? join(npmBin(p, ctx), "paseo") : ctx.paseoBinary);
/** Run systemctl against another account's user manager. Works only as root. UNVERIFIED on a real host. */
const userCtl = (p: Person, ...args: string[]) => ["systemctl", `--machine=${acct(p)}@.host`, "--user", ...args];

/**
 * Each person gets their own Linux user (own uid, home, PASEO_HOME). The OS enforces separation.
 * Provider logins are NOT shared: each account needs its own login, or an API key in that daemon's env.
 * Every step here changes the host and needs root.
 */
export const unixAccount: IsolationStrategy = {
  id: "unix-account",

  validate(person, ctx) {
    const errors: string[] = [];
    if (!person.unixAccount) errors.push(`${person.name}: isolation "unix-account" requires unixAccount`);
    if (isSeparate(person) && ctx.paseoVersion === undefined) {
      errors.push(`${person.name}: install "separate" requires paseoVersion`);
    }
    return errors;
  },

  paseoHome: home,

  plan(person, ctx) {
    const n = person.name;
    const a = acct(person);
    const root = (s: Omit<Step, "privileged">): Step => ({ ...s, privileged: true });
    const install = isSeparate(person) ? installSteps(person, ctx, root) : [];
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
      ...install,
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
            paseoBinary: daemonBinary(person, ctx),
            // A separate install gets a PATH of its own directories; others keep the unit without a PATH, as before.
            ...(isSeparate(person) ? { environmentPath: `${npmBin(person, ctx)}:${SYSTEM_PATH}` } : {}),
            envFile: envFile(person, ctx),
            optionalEnvFile: optionalEnvFile(person, ctx),
            ...(ctx.webUi ? { webUi: true } : {}),
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
        description: isSeparate(person)
          ? `MANUAL: LLM logins are NOT shared and the plan never logs in for you. Log in as ${a} (for example: sudo -iu ${a}, with ` +
            `${npmBin(person, ctx)} on PATH), once per provider, see the ${n}.login-* steps. ` +
            `Or put an API key in ${optionalEnvFile(person, ctx)} (0600, owned by ${a}; the unit reads it if present). ` +
            `Whether these login flows work for a per-account npm install is UNVERIFIED.`
          :
          `MANUAL: LLM logins are NOT shared. Log each provider CLI in as ${a} (for example: sudo -iu ${a}), or put an API key ` +
          `in ${optionalEnvFile(person, ctx)} (0600, owned by ${a}; the unit reads it if present). Which variables each provider reads is UNVERIFIED.`,
        kind: "manual",
      },
      ...(isSeparate(person) ? loginSteps(person, ctx) : []),
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
        // A separate person's plan must not name the operator's home. A same-user PASEO_HOME under userHome (the
        // default) is covered by verify-operator-home below, so the neighbour check is left out there.
        const neighbour = join(ctx.homeBase, other.name);
        if (isSeparate(person) && inside(ctx.userHome, neighbour)) continue;
        steps.push({
          id: `${person.name}.${other.name}.verify-unreadable-from-account`,
          description: `${a} cannot read ${other.name}'s PASEO_HOME (same-user daemon)`,
          kind: "command",
          command: ["sudo", "-u", a, "test", "!", "-r", neighbour],
          privileged: true,
        });
      }
    }
    if (isSeparate(person)) {
      steps.push({
        id: `${person.name}.verify-install`,
        description: `${a}'s own paseo starts (prints its version; it is the pinned ${ctx.paseoVersion ?? "?"}) (UNVERIFIED on a real host)`,
        kind: "command",
        command: asAccount(person, ctx, daemonBinary(person, ctx), "--version"),
        privileged: true,
      });
      steps.push({
        id: `${person.name}.verify-operator-home`,
        description: `${a} cannot read the operator's home directory (hand-run; UNVERIFIED on a real host)`,
        kind: "command",
        command: asAccount(person, ctx, "test", "!", "-r", ctx.userHome),
        privileged: true,
      });
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

/**
 * Steps that give a separate person their own paseo and provider CLIs: one npm prefix inside the account home.
 * Describes only. Versions: paseo is pinned to `paseoVersion`; provider CLIs are not pinned (latest at install time).
 * That the installs and each provider's login work for a per-account prefix is UNVERIFIED on a real host.
 */
function installSteps(person: Person, ctx: ResolvedConfig, root: (s: Omit<Step, "privileged">) => Step): Step[] {
  const n = person.name;
  const a = acct(person);
  const version = ctx.paseoVersion;
  // Fail closed: no silent default version, and getProvider throws on an unknown provider id.
  if (version === undefined) throw new Error(`${n}: install "separate" requires paseoVersion`);
  const providers = person.providers.map((id) => getProvider(id));
  if (providers.length === 0) throw new Error(`${n}: install "separate" requires at least one provider`);
  const prefix = npmPrefix(person, ctx);
  const npmInstall = (pkg: string) => asAccount(person, ctx, "npm", "install", "--global", "--prefix", prefix, pkg);
  return [
    root({
      id: `${n}.local-dir`,
      description: `${a}'s .local (0700, owned by ${a})`,
      kind: "dir",
      dir: { path: join(accountHome(person, ctx), ".local"), mode: "0700", owner: a },
    }),
    root({
      id: `${n}.npm-prefix`,
      description: `${a}'s own npm prefix (0700, owned by ${a}); binaries go to ${npmBin(person, ctx)}`,
      kind: "dir",
      dir: { path: prefix, mode: "0700", owner: a },
    }),
    root({
      id: `${n}.install-paseo`,
      description: `Install @getpaseo/cli@${version} into ${a}'s npm prefix, as ${a} (UNVERIFIED on a real host)`,
      kind: "command",
      command: npmInstall(`@getpaseo/cli@${version}`),
    }),
    ...providers.map((pr) =>
      root({
        id: `${n}.install-${pr.id}`,
        description: `Install ${pr.npmPackage} (latest, not pinned) into ${a}'s npm prefix, as ${a} (UNVERIFIED on a real host)`,
        kind: "command",
        command: npmInstall(pr.npmPackage),
      }),
    ),
  ];
}

/**
 * One manual login step per listed provider. Never runs a login, never copies or references a credential: the person
 * logs in themselves as their own account. Whether each login flow works for a per-account npm install is UNVERIFIED.
 */
function loginSteps(person: Person, ctx: ResolvedConfig): Step[] {
  const a = acct(person);
  return person.providers.map((id) => {
    const pr = getProvider(id);
    return {
      id: `${person.name}.login-${pr.id}`,
      description:
        `MANUAL: log in to ${pr.id} as ${a} (for example: sudo -iu ${a}, with ${npmBin(person, ctx)} on PATH): ${pr.loginHint}. ` +
        `This login is not shared with any other account. UNVERIFIED on a real host.`,
      kind: "manual",
    };
  });
}
