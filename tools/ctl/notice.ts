import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Plan } from "./plan.js";

/**
 * A short plain-language page to hand to one person. It holds only their name: no host, address, port, path or secret.
 */
export function renderNotice(name: string, isolation: string): string {
  const shared = isolation === "same-user";
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
  } else {
    lines.push(
      "## What is separate, and what is not",
      "",
      "Your Paseo runs under its own computer account. Your files and provider history are separate from the owner's.",
      "You sign in to each LLM provider yourself, or use your own key.",
      "",
    );
  }
  lines.push(
    "## Asking for separation",
    "",
    "If you want your own computer account, your own provider logins and your own history, ask the owner to set you up as a",
    "separate person. This needs the owner to change the setup; it does not happen by itself.",
    "",
  );
  return lines.join("\n");
}

/** One `notice-<name>.md` per person in the plan, into outDir (0644; contains nothing secret). */
export async function writeNotices(plan: Plan, outDir: string): Promise<string[]> {
  const written: string[] = [];
  for (const p of plan.people) {
    const path = join(outDir, `notice-${p.name}.md`);
    await writeFile(path, renderNotice(p.name, p.isolation), { mode: 0o644 });
    await chmod(path, 0o644);
    written.push(path);
  }
  return written;
}
