/**
 * Provider catalog for separate installs. npm-only: every provider CLI is installed into the account's own npm prefix
 * (`<acctHome>/.local/npm`, binaries in `<prefix>/bin`). Adding a provider is one entry here, not new strategy code.
 *
 * The package names were checked against the npm registry on 2026-11-27. UNVERIFIED on a real host: that installing
 * them into a per-account prefix works, and that the login flow named in `loginHint` works for that account.
 * The paseo CLI itself (`@getpaseo/cli`, bin `paseo`) is not a provider; it is installed from `paseoVersion`.
 */
export interface Provider {
  /** Id used in a person's `providers` list. */
  id: string;
  /** npm package that installs the CLI. */
  npmPackage: string;
  /** Binary name in `<prefix>/bin`. */
  bin: string;
  /** What the person runs themselves, in a shell as their account. The plan never logs in for them. */
  loginHint: string;
}

export const PROVIDERS: readonly Provider[] = [
  { id: "claude", npmPackage: "@anthropic-ai/claude-code", bin: "claude", loginHint: "run `claude`, then `/login`" },
  { id: "codex", npmPackage: "@openai/codex", bin: "codex", loginHint: "run `codex login`" },
  { id: "opencode", npmPackage: "opencode-ai", bin: "opencode", loginHint: "run `opencode auth login`" },
];

export const PROVIDER_IDS: readonly string[] = PROVIDERS.map((p) => p.id);

/** Fail closed: an unknown id throws, there is no default provider. */
export function getProvider(id: string): Provider {
  const found = PROVIDERS.find((p) => p.id === id);
  if (!found) throw new Error(`unknown provider "${id}" (known: ${PROVIDER_IDS.join(", ")})`);
  return found;
}
