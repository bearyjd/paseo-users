import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Plan } from "./plan.js";
import { fileSourceRel, secretSourceRel, stepArgv } from "./shell.js";

export interface CommandRunner {
  /** Runs one argv (no shell) with the output directory as cwd. Never called by tests with a real implementation. */
  run(argv: string[], opts: { cwd: string }): Promise<{ code: number }>;
}

export interface ApplyOptions {
  /** Whether the current process is root. Root runs only privileged steps; a normal user runs only the others. */
  isRoot: boolean;
  /** Run only steps whose id passes. The staleness check still covers the whole plan. Steps filtered out are not reported. */
  only?: (stepId: string) => boolean;
}

export interface ApplyResult {
  ok: boolean;
  /** Step ids in the order they ran successfully. */
  executed: string[];
  failed?: { id: string; code: number };
  /** Steps left for the other phase, and manual steps. Never run here. */
  skipped: { id: string; reason: "needs-root" | "must-not-run-as-root" | "manual" }[];
  /** argv of every command handed to the runner, in order. */
  commands: string[][];
}

export class ApplyRefused extends Error {}

/**
 * Executes the plan through an injected runner and stops at the first failure.
 * Refuses if the rendered output no longer matches the plan, so you never apply a stale review.
 */
export async function applyPlan(plan: Plan, outDirInput: string, runner: CommandRunner, opts: ApplyOptions): Promise<ApplyResult> {
  const outDir = resolve(outDirInput);
  const rendered = await readFile(resolve(outDir, "plan.json"), "utf8").catch(() => undefined);
  if (rendered === undefined) throw new ApplyRefused(`${outDir}/plan.json not found: run render first`);
  if (JSON.stringify(JSON.parse(rendered)) !== JSON.stringify(plan)) {
    throw new ApplyRefused("the rendered plan.json does not match the config: render again and review it");
  }

  // Staged files must be exactly what the reviewed plan says, or a unit edited after render would be installed as root.
  // Checked for every selected file step before the first command runs, whichever phase runs it. Secret files hold no
  // plan content (they are written from secrets/ at render), so only existence is checked for those, below.
  for (const step of plan.steps) {
    if (opts.only && !opts.only(step.id)) continue;
    if (step.kind !== "file" || step.file?.content === undefined) continue;
    const src = fileSourceRel(step.file.path);
    const staged = await readFile(resolve(outDir, src), "utf8").catch(() => undefined);
    if (staged === undefined) throw new ApplyRefused(`${src} is missing from ${outDir}: render again`);
    if (staged !== step.file.content) throw new ApplyRefused(`${src} no longer matches the plan: render again and review it`);
  }

  const result: ApplyResult = { ok: true, executed: [], skipped: [], commands: [] };
  for (const step of plan.steps) {
    if (opts.only && !opts.only(step.id)) continue;
    const argv = stepArgv(step);
    if (!argv) {
      result.skipped.push({ id: step.id, reason: "manual" });
      continue;
    }
    const privileged = step.privileged === true;
    if (privileged !== opts.isRoot) {
      result.skipped.push({ id: step.id, reason: privileged ? "needs-root" : "must-not-run-as-root" });
      continue;
    }
    if (step.kind === "file" && step.file) {
      const src = step.file.secretRef ? secretSourceRel(step.file.secretRef) : fileSourceRel(step.file.path);
      await access(resolve(outDir, src)).catch(() => {
        throw new ApplyRefused(`${src} is missing from ${outDir}: render again`);
      });
    }
    result.commands.push(argv);
    const { code } = await runner.run(argv, { cwd: outDir });
    if (code !== 0) {
      result.ok = false;
      result.failed = { id: step.id, code };
      return result;
    }
    result.executed.push(step.id);
  }
  return result;
}
