import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyPlan, ApplyRefused } from "../../tools/ctl/apply.js";
import { main, type CliIo } from "../../tools/ctl/cli.js";
import { parseConfig } from "../../tools/ctl/config.js";
import { planHost } from "../../tools/ctl/plan.js";
import { renderPlan } from "../../tools/ctl/render.js";
import { cfg, FakeRunner, tmp } from "./helpers.js";

function io(extra: Partial<CliIo> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { stdout: (t: string) => out.push(t), stderr: (t: string) => err.push(t), ...extra } as CliIo };
}

async function setup(raw: unknown = cfg()) {
  const dir = await tmp();
  const config = join(dir, "config.json");
  await writeFile(config, JSON.stringify(raw));
  return { dir, config, out: join(dir, "out") };
}

const MIXED = cfg({ people: [{ name: "ann" }, { name: "bob", isolation: "unix-account", unixAccount: "svc-bob" }] });

describe("cli", () => {
  it("plan prints a summary without secrets and does not need an output dir", async () => {
    const { config } = await setup();
    const t = io();
    expect(await main(["plan", config], t.io)).toBe(0);
    const text = t.out.join("");
    expect(text).toContain("ann  same-user  port 7100");
    expect(text).toContain("same-user isolation is not OS isolation");
    expect(text).not.toMatch(/PASEO_PASSWORD=/);
  });

  it("plan --json prints valid JSON", async () => {
    const { config } = await setup();
    const t = io();
    await main(["plan", config, "--json"], t.io);
    expect(JSON.parse(t.out.join("")).people).toHaveLength(2);
  });

  it("reports config errors with exit code 2", async () => {
    const { config } = await setup(cfg({ people: [{ name: "Bad" }] }));
    const t = io();
    expect(await main(["plan", config], t.io)).toBe(2);
    expect(t.err.join("")).toContain("invalid config");
  });

  it("render writes files and prints no password", async () => {
    const { config, out } = await setup();
    const t = io();
    expect(await main(["render", config, "--out", out], t.io)).toBe(0);
    const pw = (await readFile(join(out, "secrets/ann.password"), "utf8")).trim();
    expect(t.out.join("") + t.err.join("")).not.toContain(pw);
    expect(await main(["render", config, "--out", out, "--rotate", "ann"], io().io)).toBe(0);
    expect((await readFile(join(out, "secrets/ann.password"), "utf8")).trim()).not.toBe(pw);
  });

  it("revoke-plan prints steps and can render", async () => {
    const { config, out } = await setup();
    const t = io();
    expect(await main(["revoke-plan", config, "bob", "--out", out], t.io)).toBe(0);
    expect(t.out.join("")).toContain("bob.disable");
    expect(await main(["revoke-plan", config, "zed"], io().io)).toBe(2);
  });

  it("apply refuses without both flags and never reaches the runner", async () => {
    const { config, out } = await setup();
    await main(["render", config, "--out", out], io().io);
    for (const flags of [[], ["--yes"], ["--i-understand-this-changes-the-host"]]) {
      const runner = new FakeRunner();
      const t = io({ runner, isRoot: () => false });
      expect(await main(["apply", config, "--out", out, ...flags], t.io)).toBe(2);
      expect(runner.calls).toEqual([]);
      expect(t.err.join("")).toMatch(/refusing/);
    }
  });

  it("apply refuses when nothing was rendered or the render is stale", async () => {
    const { config, out } = await setup();
    const flags = ["--yes", "--i-understand-this-changes-the-host"];
    const runner = new FakeRunner();
    expect(await main(["apply", config, "--out", out, ...flags], io({ runner, isRoot: () => false }).io)).toBe(2);
    await main(["render", config, "--out", out], io().io);
    await writeFile(config, JSON.stringify(cfg({ people: [{ name: "ann" }, { name: "zoe" }] })));
    const t = io({ runner, isRoot: () => false });
    expect(await main(["apply", config, "--out", out, ...flags], t.io)).toBe(2);
    expect(t.err.join("")).toContain("does not match");
    expect(runner.calls).toEqual([]);
  });

  it("apply as a normal user runs only unprivileged steps, in order, via the fake runner", async () => {
    const { config, out } = await setup(MIXED);
    await main(["render", config, "--out", out], io().io);
    const runner = new FakeRunner();
    const t = io({ runner, isRoot: () => false });
    expect(await main(["apply", config, "--out", out, "--yes", "--i-understand-this-changes-the-host"], t.io)).toBe(0);
    expect(runner.calls.map((c) => c.join(" "))).toEqual([
      "install -d -m 0700 /home/tester/.paseo-people",
      "install -d -m 0700 /home/tester/.paseo-people/ann",
      "install -m 0600 secrets/ann.env /home/tester/.paseo-people/ann.env",
      "mkdir -p /home/tester/.config/systemd/user",
      "install -m 0644 files/home/tester/.config/systemd/user/paseo-ann.service /home/tester/.config/systemd/user/paseo-ann.service",
      "systemctl --user daemon-reload",
      "systemctl --user enable --now paseo-ann.service",
    ]);
    expect(t.out.join("")).toContain("skip   bob.useradd (needs-root)");
    expect(runner.calls.flat()).not.toContain("useradd");
  });

  it("apply as root runs only privileged steps", async () => {
    const { config, out } = await setup(MIXED);
    await main(["render", config, "--out", out], io().io);
    const runner = new FakeRunner();
    await main(["apply", config, "--out", out, "--yes", "--i-understand-this-changes-the-host"], io({ runner, isRoot: () => true }).io);
    const cmds = runner.calls.map((c) => c.join(" "));
    expect(cmds[0]).toBe("useradd --create-home --home-dir /home/svc-bob --shell /bin/bash --user-group svc-bob");
    expect(cmds).toContain("loginctl enable-linger svc-bob");
    expect(cmds.some((c) => c.includes("paseo-ann"))).toBe(false);
  });

  it("unknown command prints usage", async () => {
    const t = io();
    expect(await main(["bogus"], t.io)).toBe(2);
    expect(t.err.join("")).toContain("paseo-ctl");
  });
});

describe("applyPlan", () => {
  it("stops at the first failure and reports it", async () => {
    const plan = planHost(parseConfig(MIXED));
    const out = await tmp();
    await renderPlan(plan, out);
    const runner = new FakeRunner((a) => a[0] === "mkdir");
    const r = await applyPlan(plan, out, runner, { isRoot: false });
    expect(r.ok).toBe(false);
    expect(r.failed).toEqual({ id: "same-user.unit-dir", code: 1 });
    expect(r.executed).toEqual(["same-user.homebase", "ann.paseo-home", "ann.secret-env"]);
    expect(runner.calls.at(-1)?.[0]).toBe("mkdir");
    expect(runner.calls.some((c) => c.includes("enable"))).toBe(false);
  });

  it("refuses when a rendered source file is missing", async () => {
    const plan = planHost(parseConfig(cfg()));
    const out = await tmp();
    await renderPlan(plan, out);
    await rm(join(out, "secrets/ann.env"));
    await expect(applyPlan(plan, out, new FakeRunner(), { isRoot: false })).rejects.toThrow(ApplyRefused);
  });

  it("never invokes a runner for manual steps", async () => {
    const plan = planHost(parseConfig(cfg()));
    const out = await tmp();
    await renderPlan(plan, out);
    const runner = new FakeRunner();
    const r = await applyPlan(plan, out, runner, { isRoot: false });
    expect(r.skipped.map((s) => s.id)).toContain("same-user.linger");
    expect(runner.calls.flat().join(" ")).not.toContain("loginctl");
  });
});
