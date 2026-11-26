import { createInterface } from "node:readline";
import { dataDirFor, initializeInstance } from "./init.js";

/**
 * node dist/server/init-cli.js --home <PASEO_HOME> --username <name>   (password on stdin, first line)
 * The password is never taken from argv or the environment, where it would leak into process listings.
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const flag = (name: string) => args[args.indexOf(name) + 1];
  const home = flag("--home");
  const username = flag("--username");
  if (!home || !username) {
    console.error("usage: init-cli --home <PASEO_HOME> --username <name>   (password on stdin)");
    process.exit(2);
  }
  const lines = createInterface({ input: process.stdin });
  const password = await new Promise<string>((resolve) => lines.once("line", resolve));
  lines.close();
  const { userId } = await initializeInstance(dataDirFor(home), { username, password });
  console.log(`administrator created: ${userId}`);
}

void main().catch((error: Error) => {
  console.error(error.message);
  process.exit(1);
});
