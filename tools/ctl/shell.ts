import type { Step } from "./isolation/index.js";

const SAFE = /^[A-Za-z0-9_/.:=@%+,-]+$/;

export function shellQuote(arg: string): string {
  return SAFE.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}

export function secretSourceRel(name: string): string {
  return `secrets/${name}.env`;
}

export function fileSourceRel(destPath: string): string {
  return `files/${destPath.replace(/^\/+/, "")}`;
}

/**
 * True for a command that runs as another account (the `runuser` wrapper). Such a command must not start in the render
 * directory, which may sit under the operator's home: `env -i` clears variables but not the working directory.
 * The CLI runner and the generated apply.sh both use this, so the two paths cannot disagree.
 */
export const runsAsAccount = (argv: readonly string[]): boolean => argv[0] === "runuser";

/**
 * The one place a file/dir/command step becomes an argv. Sources are relative to the rendered output directory.
 * Manual steps have no command. `install` is used so mode and owner are set at creation time.
 */
export function stepArgv(step: Step): string[] | undefined {
  switch (step.kind) {
    case "command":
      return step.command;
    case "dir": {
      const d = step.dir;
      if (!d) return undefined;
      return ["install", "-d", "-m", d.mode, ...(d.owner ? ["-o", d.owner, "-g", d.owner] : []), d.path];
    }
    case "file": {
      const f = step.file;
      if (!f) return undefined;
      const src = f.secretRef ? secretSourceRel(f.secretRef) : fileSourceRel(f.path);
      return ["install", "-m", f.mode, ...(f.owner ? ["-o", f.owner, "-g", f.owner] : []), src, f.path];
    }
    default:
      return undefined;
  }
}
