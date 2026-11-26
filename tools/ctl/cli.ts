import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { applyPlan, ApplyRefused, type CommandRunner } from "./apply.js";
import { ConfigError, parseConfig, type ResolvedConfig } from "./config.js";
import { planHost, planRevoke, type Plan } from "./plan.js";
import { renderPlan } from "./render.js";
import { shellQuote, stepArgv } from "./shell.js";

export interface CliIo {
  stdout(text: string): void;
  stderr(text: string): void;
  /** Only used by `apply`. Defaults to a real process runner, so tests must always inject a fake. */
  runner?: CommandRunner;
  isRoot?: () => boolean;
}

const USAGE = `paseo-ctl: plan and render one Paseo daemon per person. It never touches a running daemon.

  plan <config.json> [--json]
  render <config.json> --out <dir> [--rotate <name>|all]
  revoke-plan <config.json> <name> [--out <dir>] [--json]
  apply <config.json> --out <dir> --yes --i-understand-this-changes-the-host

apply changes the host (files, systemd, accounts). Read <dir>/apply.sh first. Prefer running it by hand.
`;

export const spawnRunner: CommandRunner = {
  run: (argv, { cwd }) =>
    new Promise((resolve, reject) => {
      const [cmd, ...args] = argv;
      if (!cmd) return reject(new Error("empty command"));
      const child = spawn(cmd, args, { cwd, stdio: "inherit", shell: false });
      child.on("error", reject);
      child.on("close", (code) => resolve({ code: code ?? 1 }));
    }),
};

function parseFlags(args: string[], valueFlags: string[], boolFlags: string[]) {
  const positional: string[] = [];
  const values = new Map<string, string>();
  const bools = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (valueFlags.includes(a)) {
      const v = args[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      values.set(a, v);
    } else if (boolFlags.includes(a)) bools.add(a);
    else if (a.startsWith("--")) throw new Error(`unknown flag ${a}`);
    else positional.push(a);
  }
  return { positional, values, bools };
}

async function loadConfig(path: string | undefined): Promise<ResolvedConfig> {
  if (!path) throw new Error("config path required");
  return parseConfig(JSON.parse(await readFile(path, "utf8")));
}

function summary(plan: Plan): string {
  const out: string[] = ["People:"];
  for (const p of plan.people) {
    out.push(`  ${p.name}  ${p.isolation}  port ${p.port}  PASEO_HOME ${p.paseoHome}${p.unixAccount ? `  account ${p.unixAccount}` : ""}`);
  }
  if (plan.warnings.length) out.push("", "Warnings:", ...plan.warnings.map((w) => `  ! ${w}`));
  out.push("", "Steps (in order):");
  for (const s of plan.steps) {
    const argv = stepArgv(s);
    out.push(`  [${s.kind}${s.privileged ? ", root" : ""}] ${s.id}: ${s.description}`);
    if (argv && s.kind === "command") out.push(`      ${argv.map(shellQuote).join(" ")}`);
  }
  if (plan.verify.length) {
    out.push("", "Verify by hand afterwards:", ...plan.verify.map((s) => `  ${s.id}: ${s.description}`));
  }
  return `${out.join("\n")}\n`;
}

export async function main(argv: string[], io: CliIo): Promise<number> {
  const [cmd, ...rest] = argv;
  try {
    switch (cmd) {
      case "plan": {
        const { positional, bools } = parseFlags(rest, [], ["--json"]);
        const plan = planHost(await loadConfig(positional[0]));
        io.stdout(bools.has("--json") ? `${JSON.stringify(plan, null, 2)}\n` : summary(plan));
        return 0;
      }
      case "render": {
        const { positional, values } = parseFlags(rest, ["--out", "--rotate"], []);
        const out = values.get("--out");
        if (!out) throw new Error("--out <dir> required");
        const plan = planHost(await loadConfig(positional[0]));
        const rotate = values.get("--rotate");
        const r = await renderPlan(plan, out, rotate ? { rotate: rotate === "all" ? "all" : [rotate] } : {});
        io.stdout(
          `Rendered to ${r.outDir}\n  new passwords: ${r.generated.join(", ") || "none"}\n  kept passwords: ${r.kept.join(", ") || "none"}\n` +
            "  Passwords are in secrets/<name>.password. Read apply.sh before running anything.\n",
        );
        return 0;
      }
      case "revoke-plan": {
        const { positional, values, bools } = parseFlags(rest, ["--out"], ["--json"]);
        const name = positional[1];
        if (!name) throw new Error("person name required");
        const plan = planRevoke(await loadConfig(positional[0]), name);
        io.stdout(bools.has("--json") ? `${JSON.stringify(plan, null, 2)}\n` : summary(plan));
        const out = values.get("--out");
        if (out) {
          const r = await renderPlan(plan, out);
          io.stdout(`Rendered to ${r.outDir} with a rotated password for ${name}. Use a directory separate from the host plan.\n`);
        }
        return 0;
      }
      case "apply": {
        const { positional, values, bools } = parseFlags(rest, ["--out"], ["--yes", "--i-understand-this-changes-the-host"]);
        if (!bools.has("--yes") || !bools.has("--i-understand-this-changes-the-host")) {
          io.stderr("refusing: apply changes the host. Pass --yes and --i-understand-this-changes-the-host after reading apply.sh.\n");
          return 2;
        }
        const out = values.get("--out");
        if (!out) throw new Error("--out <dir> required");
        const plan = planHost(await loadConfig(positional[0]));
        const isRoot = (io.isRoot ?? (() => process.getuid?.() === 0))();
        const privileged = plan.steps.filter((s) => s.privileged && stepArgv(s));
        if (isRoot) {
          io.stderr("running as root: only privileged steps will run; run again as your normal user for the rest.\n");
        } else if (privileged.length > 0) {
          io.stderr(`${privileged.length} privileged step(s) need root and will NOT run now; run apply again as root for them.\n`);
        }
        const result = await applyPlan(plan, out, io.runner ?? spawnRunner, { isRoot });
        for (const id of result.executed) io.stdout(`ok     ${id}\n`);
        for (const s of result.skipped) io.stdout(`skip   ${s.id} (${s.reason})\n`);
        if (!result.ok) {
          io.stderr(`FAILED at ${result.failed?.id} (exit ${result.failed?.code}); later steps did not run.\n`);
          return 1;
        }
        return 0;
      }
      default:
        io.stderr(USAGE);
        return cmd === undefined || cmd === "--help" || cmd === "help" ? 0 : 2;
    }
  } catch (e) {
    if (e instanceof ConfigError || e instanceof ApplyRefused || e instanceof Error) {
      io.stderr(`${e.message}\n`);
      return 2;
    }
    throw e;
  }
}
