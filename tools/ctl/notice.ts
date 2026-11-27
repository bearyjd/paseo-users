import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Plan, PlanPerson } from "./plan.js";
import { getProvider } from "./providers.js";

/**
 * A short plain-language page to hand to one person. It holds only their name and, for a separate install, the ids of
 * their providers: no host, address, port, path, version, account name or secret. Fails closed: a separate person without
 * providers, or with an unknown one, gets no page (throws).
 */
export function renderNotice(person: Pick<PlanPerson, "name" | "isolation" | "install" | "providers">): string {
  const { name } = person;
  const shared = person.isolation === "same-user";
  const separate = person.install === "separate";
  const providers = person.providers ?? [];
  if (separate) {
    if (providers.length === 0) throw new Error(`${name}: a separate install has no providers; refusing to write a notice`);
    for (const id of providers) getProvider(id); // throws on an unknown provider
  }
  const lines = [
    `# Your Paseo, ${name}`,
    "",
    "## What is yours alone",
    "",
    "- Your Paseo sessions: the agents you start and their conversations.",
    "- Your projects: the list of projects in your Paseo.",
    "- Your password. Nobody else's password opens your Paseo, and yours does not open theirs.",
    "",
  ];
  if (shared) {
    lines.push(
      "## What is shared",
      "",
      "Your Paseo runs on the same computer account as the owner's. That means:",
      "",
      "- LLM accounts: your agents use the owner's logins for Claude, Codex and other providers, so usage and limits are shared.",
      "- Provider history: past conversations that those provider tools saved on this account can be seen and imported from your Paseo, and the other way round.",
      "- The files on the machine: your agents can read the same files as the owner's agents. This is separation of data, not a lock.",
      "",
    );
  } else if (separate) {
    lines.push(
      "## What is separate",
      "",
      "Your Paseo runs under its own computer account, with its own installs. Nothing is borrowed from the owner's account:",
      "",
      // UNVERIFIED on a real host: setup only gives the account its own private home. It does not change the owner's
      // permissions, and the owner's side is a manual check after setup, so no promise is made about the owner's files.
      "- Your own computer account, with its own private home directory. That the two accounts cannot read each other's files is checked by the owner, by hand, after setup; this page does not promise it.",
      "- Your own installs: Paseo and the provider tools below are installed for your account alone.",
      `- Your own provider logins, for ${providers.join(", ")}: you sign in to each of them yourself, as your own account. Nothing is copied from anyone else, so usage and limits are yours.`,
      "- Your own history: the conversations those provider tools save belong to your account only.",
      "",
    );
  } else {
    lines.push(
      "## What is separate, and what is not",
      "",
      "Your Paseo runs under its own computer account. Your files and provider history are separate from the owner's.",
      "You sign in to each LLM provider yourself, or use your own key.",
      "",
    );
  }
  if (!separate) {
    lines.push(
      "## Asking for separation",
      "",
      "If you want your own computer account, your own provider logins and your own history, ask the owner to set you up as a",
      "separate person. This needs the owner to change the setup; it does not happen by itself.",
      "",
    );
  }
  return lines.join("\n");
}

/** One `notice-<name>.md` per person in the plan, into outDir (0644; contains nothing secret). */
export async function writeNotices(plan: Plan, outDir: string): Promise<string[]> {
  // Render every page first: a person who cannot be described safely stops the whole set before any file is written.
  const pages = plan.people.map((p) => ({ name: p.name, text: renderNotice(p) }));
  const written: string[] = [];
  for (const { name, text } of pages) {
    const path = join(outDir, `notice-${name}.md`);
    await writeFile(path, text, { mode: 0o644 });
    await chmod(path, 0o644);
    written.push(path);
  }
  return written;
}
