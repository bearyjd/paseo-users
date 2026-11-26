import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connect, startDisposableDaemon, type Harness } from "./daemon-harness.js";

/**
 * Two independent daemons on one host and one Linux user (the "same-user" daemon-per-person mode).
 * Verifies the data separation it relies on, and that one directory can be a project in both.
 * Disposable only: two temp homes, loopback, ephemeral ports. Opt in with PASEO_PROBE=1.
 */
const enabled = process.env.PASEO_PROBE === "1";
const cli = () =>
  process.env.PASEO_PROBE_CLI ?? execFileSync("realpath", [execFileSync("which", ["paseo"], { encoding: "utf8" }).trim()], { encoding: "utf8" }).trim();

describe.skipIf(!enabled)("two same-user daemons", () => {
  let a: Harness;
  let b: Harness;
  let work: string;

  beforeAll(async () => {
    work = await realpath(await mkdtemp(join(tmpdir(), "paseo-users-two-work-")));
    a = await startDisposableDaemon(cli());
    b = await startDisposableDaemon(cli());
  });
  afterAll(async () => {
    await Promise.all([a?.stop(), b?.stop()]);
    if (work) await rm(work, { recursive: true, force: true });
  });

  const projects = async (h: Harness, id: string) => {
    const s = await connect(h, { password: h.password, clientId: id });
    const r = JSON.stringify(await s.request({ type: "project.list.request" }));
    s.close();
    return r;
  };
  const add = async (h: Harness, cwd: string, id: string) => {
    const s = await connect(h, { password: h.password, clientId: id });
    const r = await s.request({ type: "project.add.request", cwd });
    s.close();
    return r;
  };

  it("each daemon has its own password: one person's password does not open the other's daemon", async () => {
    const wrong = await connect(b, { password: a.password, clientId: "cross" });
    expect(wrong.serverInfo).toBeNull();
    expect(wrong.rejected).toMatchObject({ reason: "incorrect_password" });
    const right = await connect(b, { password: b.password, clientId: "own" });
    expect(right.serverInfo).not.toBeNull();
    right.close();
  });

  it("project registries are separate", async () => {
    await mkdir(join(work, "only-a"));
    expect((await add(a, join(work, "only-a"), "a1")).type).toBe("project.add.response");
    expect(await projects(a, "a2")).toContain("only-a");
    expect(await projects(b, "b1")).not.toContain("only-a");
  });

  it("the same directory can be a project in both daemons", async () => {
    await mkdir(join(work, "shared-repo"));
    expect((await add(a, join(work, "shared-repo"), "a3")).type).toBe("project.add.response");
    expect((await add(b, join(work, "shared-repo"), "b2")).type).toBe("project.add.response");
    expect(await projects(a, "a4")).toContain("shared-repo");
    expect(await projects(b, "b3")).toContain("shared-repo");
  });
});
