import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Every test temp dir lives under one per-run root that is removed afterwards. */
export default function setup() {
  const root = mkdtempSync(join(tmpdir(), "paseo-users-run-"));
  process.env.TMPDIR = root;
  return () => rmSync(root, { recursive: true, force: true });
}
