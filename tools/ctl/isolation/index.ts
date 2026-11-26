import type { Person, ResolvedConfig } from "../config.js";

/**
 * One unit of work in a plan. The planner only describes steps; nothing here executes anything.
 * `apply.ts` is the single place where steps become commands, and it only does so through an injected runner.
 */
export interface Step {
  id: string;
  description: string;
  kind: "command" | "file" | "dir" | "manual";
  /** argv, never a shell string. */
  command?: string[];
  /** True when the step needs root. Unprivileged steps must NOT run as root (they would create root-owned files). */
  privileged?: boolean;
  file?: {
    /** Absolute destination on the target host. */
    path: string;
    /** Octal string, e.g. "0600". */
    mode: string;
    owner?: string;
    /** Rendered content. Never a secret. */
    content?: string;
    /** Name of a person whose secret env file this step installs. The content is produced by render, not by the plan. */
    secretRef?: string;
  };
  dir?: { path: string; mode: string; owner?: string };
}

export interface IsolationStrategy {
  readonly id: string;
  /** Strategy-specific config problems for one person. Empty means valid. */
  validate(person: Person, ctx: ResolvedConfig): string[];
  /** The person's PASEO_HOME on the target host. */
  paseoHome(person: Person, ctx: ResolvedConfig): string;
  plan(person: Person, ctx: ResolvedConfig): Step[];
  revoke(person: Person, ctx: ResolvedConfig): Step[];
  /** Checks to run by hand after apply. Never executed by this tool. */
  verify(person: Person, others: Person[], ctx: ResolvedConfig): Step[];
}

export interface IsolationRegistry {
  ids(): string[];
  has(id: string): boolean;
  /** Throws on an unknown id (fail closed). */
  get(id: string): IsolationStrategy;
}

export function createRegistry(strategies: IsolationStrategy[]): IsolationRegistry {
  const map = new Map<string, IsolationStrategy>();
  for (const s of strategies) {
    if (map.has(s.id)) throw new Error(`duplicate isolation strategy: ${s.id}`);
    map.set(s.id, s);
  }
  return {
    ids: () => [...map.keys()],
    has: (id) => map.has(id),
    get(id) {
      const s = map.get(id);
      if (!s) throw new Error(`unknown isolation strategy "${id}" (known: ${[...map.keys()].join(", ")})`);
      return s;
    },
  };
}
