import { posix } from "node:path";
import { ConfigError, EXACT_VERSION, UNIX_NAME, type Person, type ResolvedConfig } from "./config.js";
import { PROVIDER_IDS } from "./providers.js";
import { sharedLayout } from "./isolation/same-user.js";
import { accountLayout } from "./isolation/unix-account.js";
import { defaultRegistry } from "./isolation/registry.js";
import type { IsolationRegistry, Step } from "./isolation/index.js";

export interface PlanPerson {
  name: string;
  isolation: string;
  port: number;
  paseoHome: string;
  unixAccount?: string;
  /** Set only for a separate install, so the plan of a person without install is unchanged. */
  install?: "separate";
  /** Provider ids installed for a separate person, in config order. Present only together with `install`. */
  providers?: string[];
}

export interface Plan {
  people: PlanPerson[];
  /** Ordered. Apply runs these (the unprivileged ones as a user, the privileged ones as root). */
  steps: Step[];
  /** Manual or hand-run checks for after apply. Never executed by this tool. */
  verify: Step[];
  warnings: string[];
  /** People whose password render must rotate (set by planRevoke). */
  rotate: string[];
}

/** Steps shared by several people carry one id; keep the first and refuse conflicting duplicates. */
function dedupe(steps: Step[]): Step[] {
  const byId = new Map<string, Step>();
  const out: Step[] = [];
  for (const s of steps) {
    const prev = byId.get(s.id);
    if (!prev) {
      byId.set(s.id, s);
      out.push(s);
    } else if (JSON.stringify(prev) !== JSON.stringify(s)) {
      throw new Error(`conflicting steps share the id ${s.id}`);
    }
  }
  return out;
}

function describe(p: Person, ctx: ResolvedConfig, registry: IsolationRegistry): PlanPerson {
  return {
    name: p.name,
    isolation: p.isolation,
    port: p.port,
    paseoHome: registry.get(p.isolation).paseoHome(p, ctx),
    ...(p.unixAccount ? { unixAccount: p.unixAccount } : {}),
    ...(p.install === "separate" ? { install: "separate" as const, providers: [...p.providers] } : {}),
  };
}

function warningsFor(people: Person[], ctx: ResolvedConfig): string[] {
  const w: string[] = [];
  const same = people.filter((p) => p.isolation === "same-user");
  const unix = people.filter((p) => p.isolation === "unix-account");
  if (same.length > 1) {
    w.push(
      "same-user isolation is not OS isolation: these daemons run as one Linux user, so each daemon's agents can read " +
        `the others' files (${same.map((p) => p.name).join(", ")})`,
    );
  }
  if (same.length > 0 && ctx.existingDaemons.length > 0) {
    w.push(
      "existingDaemons is set: if any of them runs as the same Linux user, same-user agents can read that daemon's " +
        "PASEO_HOME, including its credentials",
    );
  }
  if (same.length > 1 || (same.length > 0 && ctx.existingDaemons.length > 0)) {
    w.push(
      "same-user daemons share the Linux user's provider session history (for example Claude and Codex conversations) and " +
        "project directories: each person can see and import the others' past provider sessions, and the project suggestions " +
        "list every directory the user has worked in. Paseo's own sessions, projects and passwords stay separate",
    );
  }
  if (unix.length > 0) {
    w.push(
      `LLM logins are not shared for unix-account people (${unix.map((p) => p.name).join(", ")}): each account needs ` +
        "its own provider login, or an API key in that daemon's environment",
    );
  }
  const separate = unix.filter((p) => p.install === "separate");
  if (separate.length > 0) {
    const names = separate.map((p) => p.name).join(", ");
    w.push(
      `provider CLIs for separate installs (${names}) are installed unpinned: the latest version at install time, not a ` +
        "version you chose (only paseo itself is pinned by paseoVersion)",
    );
    w.push(
      `each separate person (${names}) needs their own logins: log in to every listed provider by hand as that account; ` +
        "no login or credential is copied from you or from anyone else",
    );
  }
  if (same.length + unix.length > 0) {
    w.push("daemon passwords are stored in plaintext in 0600 EnvironmentFiles (paseo daemon set-password has no documented non-interactive input)");
  }
  if (["0.0.0.0", "::", "[::]"].includes(ctx.listenAddress)) {
    w.push("daemons listen on every interface; make sure the network in front of them is trusted");
  }
  if (ctx.webUi) {
    w.push(
      "webUi is on: each daemon serves the web UI page to anyone who can reach its port (the API still needs that daemon's password); keep the port on a trusted network",
    );
  }
  return w;
}

export function planHost(ctx: ResolvedConfig, registry: IsolationRegistry = defaultRegistry): Plan {
  const steps: Step[] = [];
  const verify: Step[] = [];
  for (const p of ctx.people) {
    const s = registry.get(p.isolation);
    steps.push(...s.plan(p, ctx));
    verify.push(...s.verify(p, ctx.people.filter((o) => o.name !== p.name), ctx));
  }
  return {
    people: ctx.people.map((p) => describe(p, ctx, registry)),
    steps: dedupe(steps),
    verify: dedupe(verify),
    warnings: warningsFor(ctx.people, ctx),
    rotate: [],
  };
}

export function planRevoke(ctx: ResolvedConfig, name: string, registry: IsolationRegistry = defaultRegistry): Plan {
  const person = ctx.people.find((p) => p.name === name);
  if (!person) throw new Error(`unknown person "${name}" (known: ${ctx.people.map((p) => p.name).join(", ")})`);
  const warnings = warningsFor([person], ctx).filter((w) => !w.startsWith("same-user isolation is not OS"));
  if (person.isolation === "same-user") {
    warnings.unshift(
      "same-user revocation stops the daemon and rotates its password; it cannot undo what this person's agents could " +
        "already read as your Linux user",
    );
  }
  return {
    people: [describe(person, ctx, registry)],
    steps: dedupe(registry.get(person.isolation).revoke(person, ctx)),
    verify: [],
    warnings,
    rotate: [person.name],
  };
}

/**
 * Only one person's part of a plan: their own steps (ids starting `<name>.`) and, unless they are a separate install,
 * the shared same-user prerequisites (ids starting `same-user.`). A separate person's plan never carries those: they
 * name the operator's home and are not that person's to run. Warnings are kept whole, because they describe the whole
 * setup. The plan must already be built from the whole config, so validation and port assignment still cover everyone.
 */
export function planForPerson(plan: Plan, name: string): Plan {
  const person = plan.people.find((p) => p.name === name);
  if (!person) throw new Error(`unknown person "${name}" (known: ${plan.people.map((p) => p.name).join(", ")})`);
  const belongs = personStepFilter(plan, name);
  return {
    ...plan,
    people: [person],
    steps: plan.steps.filter((s) => belongs(s.id)),
    verify: plan.verify.filter((s) => s.id.startsWith(`${name}.`)),
  };
}

/** Which step ids `apply <name>` and `plan <name>` cover. Fails closed on an unknown person. */
export function personStepFilter(plan: Plan, name: string): (stepId: string) => boolean {
  const person = plan.people.find((p) => p.name === name);
  if (!person) throw new Error(`unknown person "${name}" (known: ${plan.people.map((p) => p.name).join(", ")})`);
  const separate = person.install === "separate";
  return (stepId) => stepId.startsWith(`${name}.`) || (!separate && stepId.startsWith("same-user."));
}

/**
 * Moving a person from the shared layout (same-user) to their own account and installs, on the SAME port.
 * The config describes the TARGET (unix-account, install separate); the SOURCE is the person's same-user layout. Describes
 * only: nothing runs here, and none of it has been run on a real host (UNVERIFIED). Never rotates the password.
 *
 * apply runs the unprivileged and the privileged steps in separate invocations, in either order. So the plan cannot rely
 * on the stop having happened when the root phase starts: the first privileged step is a guard that fails while the old
 * daemon may still run, and apply stops at the first failure, so no account, move or copy can follow a failed guard.
 */
export function planMigrate(ctx: ResolvedConfig, name: string, registry: IsolationRegistry = defaultRegistry): Plan {
  const person = ctx.people.find((p) => p.name === name);
  if (!person) throw new Error(`unknown person "${name}" (known: ${ctx.people.map((p) => p.name).join(", ")})`);
  // planMigrate is exported and takes a ResolvedConfig that may be hand-built, so what parseConfig checks is checked again
  // here, as ConfigError and before any step exists.
  if (person.isolation !== "unix-account" || person.install !== "separate") {
    throw new ConfigError([
      `${name}: migrate moves a person to a separate install, so the config must describe them as isolation "unix-account" ` +
        `with install "separate" (use "paseo-users add ${name} --separate ..." to describe the target first)`,
    ]);
  }
  const targetIssues: string[] = [];
  if (ctx.paseoVersion === undefined || !EXACT_VERSION.test(ctx.paseoVersion)) {
    targetIssues.push(`${name}: paseoVersion must be an exact version (x.y.z, optional -prerelease) for a separate install, got ${ctx.paseoVersion === undefined ? "none" : `"${ctx.paseoVersion}"`}`);
  }
  if (person.providers.length === 0) targetIssues.push(`${name}: install "separate" requires at least one provider (known: ${PROVIDER_IDS.join(", ")})`);
  for (const id of person.providers) {
    if (!PROVIDER_IDS.includes(id)) targetIssues.push(`${name}: unknown provider "${id}" (known: ${PROVIDER_IDS.join(", ")})`);
  }
  for (const id of new Set(person.providers.filter((id, i) => person.providers.indexOf(id) !== i))) {
    targetIssues.push(`${name}: duplicate provider "${id}"`);
  }
  // The account name goes straight into useradd, chown and every runuser step, so it is checked as parseConfig checks it.
  if (person.unixAccount === undefined || !UNIX_NAME.test(person.unixAccount)) {
    targetIssues.push(`${name}: unixAccount must be a portable POSIX user name, got ${person.unixAccount === undefined ? "none" : `"${person.unixAccount}"`}`);
  } else if (person.unixAccount === "root") {
    targetIssues.push(`${name}: unixAccount must not be root`);
  }
  if (targetIssues.length > 0) throw new ConfigError(targetIssues);
  const strategy = registry.get(person.isolation);
  const n = name;
  const old = sharedLayout(person, ctx);
  const next = accountLayout(person, ctx);
  const root = (s: Omit<Step, "privileged">): Step => ({ ...s, privileged: true });

  // Fail closed before any step exists: the source is moved and chowned as root, so it must be a directory of its own and
  // never the operator's home (a homeBase that is the parent of userHome would make `ann`'s home be userHome itself).
  const inside = (parent: string, child: string) => {
    const rel = posix.relative(parent, child);
    return rel === "" || (rel !== ".." && !rel.startsWith("../") && !posix.isAbsolute(rel));
  };
  for (const [label, path] of [["PASEO_HOME", old.home], ["env file", old.envFile]] as const) {
    if (inside(path, ctx.userHome)) {
      throw new ConfigError([`${n}: the old ${label} ${path} equals or contains userHome ${ctx.userHome}; migrate would move or take over your own home. Choose another homeBase`]);
    }
  }

  // The shared layout puts a person's data in a directory of its own below homeBase. A homeBase that is userHome would make
  // the source an ordinary directory of the operator's home (~/<name>), which the shared layout could never have created.
  if (ctx.homeBase === ctx.userHome) {
    throw new ConfigError([`${n}: homeBase ${ctx.homeBase} is userHome itself, so the old PASEO_HOME ${old.home} would be an ordinary directory of your own home. Choose another homeBase`]);
  }
  // mv and chown take the whole source to the new account. Anything the host keeps using that lies inside it would go along.
  const operatorPaths: [string, string][] = [["paseoBinary", ctx.paseoBinary]];
  for (const entry of (ctx.environmentPath ?? "").split(":")) {
    if (entry === "") continue;
    const expanded = entry === "%h" || entry.startsWith("%h/") ? posix.join(ctx.userHome, entry.slice(2)) : posix.normalize(entry);
    operatorPaths.push(["environmentPath entry", expanded]);
  }
  for (const [label, path] of operatorPaths) {
    for (const [what, source] of [["PASEO_HOME", old.home], ["env file", old.envFile]] as const) {
      if (inside(source, path)) {
        throw new ConfigError([`${n}: ${label} ${path} is inside the old ${what} ${source}, which migrate moves and gives to ${next.account}; the host would lose it. Move it out first or choose another homeBase`]);
      }
    }
  }

  const stop: Step = {
    id: `${n}.stop-shared`,
    description: `Stop and disable the shared unit ${old.unit} in your own user manager, so the old daemon is down before its PASEO_HOME moves (UNVERIFIED on a real host)`,
    kind: "command",
    command: ["systemctl", "--user", "disable", "--now", old.unit],
  };
  const guard = root({
    id: `${n}.guard-old-daemon-stopped`,
    description:
      `Refuse to continue while the old daemon may still run: ${old.home}/paseo.pid must not exist (the daemon writes it while it runs; ` +
      `that it removes it on a clean stop is UNVERIFIED on a real host). Apply runs the unprivileged and root steps separately, ` +
      `so this check, not the order you run them in, is what keeps the move from happening under a live daemon. ` +
      `If it fails, run the unprivileged phase (the ${old.unit} stop) first; a stale file after a crash must be removed by you once you have checked no daemon runs`,
    kind: "command",
    command: ["test", "!", "-e", `${old.home}/paseo.pid`],
  });
  // Preflight on the old layout. All root, all before the account exists, so a missing or planted source fails before the
  // host changes (a half-made account cannot be resumed). Each is one argv, no shell. UNVERIFIED on a real host.
  const unitDir = posix.join(ctx.userHome, ".config", "systemd", "user");
  const wants = posix.join(unitDir, "default.target.wants", old.unit);
  const unitFile = posix.join(unitDir, old.unit);
  const listenLine = `Environment=PASEO_LISTEN=${ctx.listenAddress}:${person.port}`;
  const pre = (id: string, description: string, command: string[]): Step =>
    root({ id: `${n}.guard-old-${id}`, description: `${description} (UNVERIFIED on a real host)`, kind: "command", command });
  // Every directory above the old PASEO_HOME, from the top (not "/"): a symbolic link in any of them would let mv and chown
  // follow it to somewhere else, while the checks on the final component below would still pass. find does not follow
  // links by default, so -type l matches a link at a start path itself, and -exec false makes find exit non-zero for it.
  const parents: string[] = [];
  for (let d = posix.dirname(old.home); d !== "/" && d !== "."; d = posix.dirname(d)) parents.unshift(d);
  const preflight: Step[] = [
    pre("parents", `Refuse to continue if any directory above ${old.home} (${parents.join(", ")}) is a symbolic link: mv and chown would follow it to somewhere else, and the checks on ${old.home} itself would not notice. If one is a link on your host, set homeBase to the real path`, ["find", ...parents, "-maxdepth", "0", "-type", "l", "-exec", "false", "{}", "+"]),
    pre("unit-disabled", `Refuse to continue while ${old.unit} is still enabled (${wants} exists): a unit that is starting or waiting to restart has no ${old.home}/paseo.pid yet, and an enabled one would start a second daemon at the next login or boot. Run the unprivileged ${old.unit} stop first`, ["test", "!", "-L", wants]),
    pre("home-link", `Refuse to continue if ${old.home} is a symbolic link (mv would move the link and leave the data behind)`, ["test", "!", "-L", old.home]),
    pre("home-dir", `Refuse to continue unless ${old.home} exists as a directory, so a wrong homeBase or an already migrated person fails before the account is created`, ["test", "-d", old.home]),
    pre("env-link", `Refuse to continue if ${old.envFile} is a symbolic link (root would follow it and copy the target to ${next.account})`, ["test", "!", "-L", old.envFile]),
    pre("env-file", `Refuse to continue unless ${old.envFile} exists as a regular file, so the password copy cannot fail after the move`, ["test", "-f", old.envFile]),
    pre(
      "hardlinks",
      `Refuse to continue if anything under ${old.home} other than a directory has more than one hard link: chown changes the inode, so a link to a file outside the home would hand that file to ${next.account}. find exits non-zero when the -exec + command fails; a race with a running process is not closed (the daemon is stopped by the guard above)`,
      ["find", old.home, "!", "-type", "d", "-links", "+1", "-exec", "false", "{}", "+"],
    ),
    pre(
      "port",
      `Refuse to continue unless the old unit ${unitFile} has the line ${listenLine}: the person keeps the SAME port, so the port in your config must be the one the shared daemon listens on now, or every saved connection breaks. If it fails, set the port in the config to the old one (paseo-users add ${n} --separate ... --port <old port>) and render again`,
      ["grep", "-q", "-x", "-F", "-e", listenLine, "--", unitFile],
    ),
  ];
  const move = root({
    id: `${n}.move-paseo-home`,
    description:
      `Move ${n}'s PASEO_HOME ${old.home} to ${next.home} (keeps their sessions, projects, server identity and password). ` +
      `-T makes the destination the new PASEO_HOME itself: if it exists, mv fails instead of nesting (UNVERIFIED on a real host)`,
    kind: "command",
    command: ["mv", "-T", old.home, next.home],
  });
  const chown = root({
    id: `${n}.chown-paseo-home`,
    description: `Give ${next.account} ownership of the moved PASEO_HOME, recursively, without following symbolic links (UNVERIFIED on a real host)`,
    kind: "command",
    command: ["chown", "-R", "-h", `${next.account}:${next.account}`, next.home],
  });
  const carry = root({
    id: `${n}.carry-secret-env`,
    description:
      `Carry ${n}'s existing password file ${old.envFile} to ${next.envFile} (0600, owned by ${next.account}): the saved connection and ` +
      `password keep working and nothing is rotated or rendered. The old file stays where it is; delete it yourself when done (UNVERIFIED on a real host)`,
    kind: "command",
    command: ["install", "-m", "0600", "-o", next.account, "-g", next.account, old.envFile, next.envFile],
  });
  const note: Step = {
    id: `${n}.migrate-note`,
    description:
      `MANUAL: ${n}'s provider logins start fresh in ${next.account}: log in again to each provider (see the ${n}.login-* steps). ` +
      `Your own provider history and logins stay behind and are not copied. Delete ${old.envFile} when you are satisfied. UNVERIFIED on a real host.`,
    kind: "manual",
  };

  // The account and installs are the slice 2 steps, minus a fresh PASEO_HOME (mv would nest the old one inside it) and
  // minus a rendered password (the existing one is carried across instead).
  const fresh = strategy.plan(person, ctx).filter((s) => s.id !== `${n}.paseo-home` && s.id !== `${n}.secret-env`);
  const steps: Step[] = [stop, guard, ...preflight];
  for (const s of fresh) {
    steps.push(s);
    // The move needs the account home to exist, and both moves come before any account code runs.
    if (s.id === `${n}.account-home`) steps.push(move, chown);
    if (s.id === `${n}.guard-secret-env`) steps.push(carry);
  }
  steps.push(note);
  for (const id of [move.id, chown.id, carry.id]) {
    if (!steps.some((s) => s.id === id)) throw new Error(`${n}: the account plan has no place for ${id}`);
  }

  const others = ctx.people.filter((o) => o.name !== n && o.isolation !== "same-user");
  return {
    people: [describe(person, ctx, registry)],
    steps: dedupe(steps),
    verify: dedupe(strategy.verify(person, others, ctx)).filter((s) => s.id.startsWith(`${n}.`)),
    warnings: warningsFor([person], ctx),
    rotate: [],
  };
}
