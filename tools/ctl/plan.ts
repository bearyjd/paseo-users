import type { Person, ResolvedConfig } from "./config.js";
import { defaultRegistry } from "./isolation/registry.js";
import type { IsolationRegistry, Step } from "./isolation/index.js";

export interface PlanPerson {
  name: string;
  isolation: string;
  port: number;
  paseoHome: string;
  unixAccount?: string;
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
  if (unix.length > 0) {
    w.push(
      `LLM logins are not shared for unix-account people (${unix.map((p) => p.name).join(", ")}): each account needs ` +
        "its own provider login, or an API key in that daemon's environment",
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
