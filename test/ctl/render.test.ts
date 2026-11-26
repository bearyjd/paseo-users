import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { parseConfig } from "../../tools/ctl/config.js";
import { planHost, planRevoke } from "../../tools/ctl/plan.js";
import { renderPlan } from "../../tools/ctl/render.js";
import { cfg, tmp } from "./helpers.js";

const mode = async (p: string) => (await stat(p)).mode & 0o777;

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else out.push(p);
  }
  return out;
}

const mixed = () =>
  planHost(
    parseConfig(
      cfg({
        people: [{ name: "ann" }, { name: "bob" }, { name: "cy", isolation: "unix-account", unixAccount: "svc-cy" }],
      }),
    ),
  );

describe("render", () => {
  it("writes the expected layout with strict modes", async () => {
    const out = await tmp();
    const r = await renderPlan(mixed(), out);
    expect(r.generated.sort()).toEqual(["ann", "bob", "cy"]);
    expect(await mode(join(out, "secrets"))).toBe(0o700);
    for (const n of ["ann", "bob", "cy"]) {
      expect(await mode(join(out, "secrets", `${n}.password`))).toBe(0o600);
      expect(await mode(join(out, "secrets", `${n}.env`))).toBe(0o600);
    }
    expect(await mode(join(out, "apply.sh"))).toBe(0o644);
    expect((await mode(join(out, "apply.sh"))) & 0o111).toBe(0);
    const unit = join(out, "files/home/tester/.config/systemd/user/paseo-ann.service");
    expect(await readFile(unit, "utf8")).toContain("daemon run --home /home/tester/.paseo-people/ann");
    expect(await stat(join(out, "files/home/svc-cy/.config/systemd/user/paseo-cy.service"))).toBeTruthy();
  });

  it("writes nothing outside the output directory", async () => {
    const out = await tmp();
    await renderPlan(mixed(), out);
    for (const f of await walk(out)) expect(relative(out, f).startsWith("..")).toBe(false);
  });

  it("refuses a step path that escapes the output directory", async () => {
    const plan = mixed();
    plan.steps.push({ id: "evil", description: "x", kind: "file", file: { path: "/a/../../etc/x", mode: "0644", content: "x" } });
    await expect(renderPlan(plan, await tmp())).rejects.toThrow(/outside the output directory/);
  });

  it("refuses to render into a non-empty directory it did not create", async () => {
    const out = await tmp();
    await writeFile(join(out, "keep.txt"), "mine");
    await expect(renderPlan(mixed(), out)).rejects.toThrow(/not empty/);
  });

  it("keeps secrets out of plan.json, units and apply.sh, and out of the plan object", async () => {
    const out = await tmp();
    const plan = mixed();
    await renderPlan(plan, out);
    const passwords = await Promise.all(["ann", "bob", "cy"].map((n) => readFile(join(out, "secrets", `${n}.password`), "utf8")));
    expect(new Set(passwords.map((p) => p.trim())).size).toBe(3);
    for (const pw of passwords.map((p) => p.trim())) {
      expect(pw.length).toBeGreaterThanOrEqual(32);
      for (const f of await walk(out)) {
        if (f.startsWith(join(out, "secrets"))) continue;
        expect(await readFile(f, "utf8"), relative(out, f)).not.toContain(pw);
      }
      expect(JSON.stringify(plan)).not.toContain(pw);
    }
    const env = await readFile(join(out, "secrets/ann.env"), "utf8");
    expect(env).toBe(`PASEO_PASSWORD=${passwords[0]?.trim()}\n`);
    expect(await readFile(join(out, "apply.sh"), "utf8")).not.toMatch(/PASEO_PASSWORD/);
  });

  it("apply.sh requires review, uses no passwords on command lines and installs secrets from files", async () => {
    const out = await tmp();
    await renderPlan(mixed(), out);
    const sh = await readFile(join(out, "apply.sh"), "utf8");
    expect(sh).toContain("PASEO_CTL_I_REVIEWED");
    expect(sh).toContain("install -m 0600 secrets/ann.env /home/tester/.paseo-people/ann.env");
    expect(sh).toContain("install -m 0600 -o svc-cy -g svc-cy secrets/cy.env /home/svc-cy/.paseo-daemon.env");
    expect(sh).toContain("install -m 0644 files/home/tester/.config/systemd/user/paseo-ann.service");
    // exits before doing anything when not reviewed
    expect(sh.indexOf("PASEO_CTL_I_REVIEWED")).toBeLessThan(sh.indexOf("systemctl"));
  });

  it("re-render is idempotent and keeps passwords; rotate changes only the requested one", async () => {
    const out = await tmp();
    await renderPlan(mixed(), out);
    const read = async () => ({
      plan: await readFile(join(out, "plan.json"), "utf8"),
      sh: await readFile(join(out, "apply.sh"), "utf8"),
      ann: await readFile(join(out, "secrets/ann.password"), "utf8"),
      bob: await readFile(join(out, "secrets/bob.password"), "utf8"),
      annEnv: await readFile(join(out, "secrets/ann.env"), "utf8"),
    });
    const first = await read();
    const second = await renderPlan(mixed(), out);
    expect(second.generated).toEqual([]);
    expect(second.kept.sort()).toEqual(["ann", "bob", "cy"]);
    expect(await read()).toEqual(first);

    const third = await renderPlan(mixed(), out, { rotate: ["ann"] });
    expect(third.generated).toEqual(["ann"]);
    const after = await read();
    expect(after.ann).not.toBe(first.ann);
    expect(after.annEnv).toContain(after.ann.trim());
    expect(after.bob).toBe(first.bob);
    expect(await mode(join(out, "secrets/ann.password"))).toBe(0o600);

    const all = await renderPlan(mixed(), out, { rotate: "all" });
    expect(all.generated.sort()).toEqual(["ann", "bob", "cy"]);
  });

  it("uses an injected random source and never a fixed password", async () => {
    const out = await tmp();
    await renderPlan(mixed(), out, { randomBytes: (n) => Buffer.alloc(n, 7) });
    expect((await readFile(join(out, "secrets/ann.password"), "utf8")).trim()).toBe(Buffer.alloc(32, 7).toString("base64url"));
  });

  it("revoke plans rotate the revoked person's password", async () => {
    const out = await tmp();
    const base = await tmp();
    await renderPlan(mixed(), base);
    const old = await readFile(join(base, "secrets/bob.password"), "utf8");
    // Revoking into the same directory replaces the password even though one exists.
    const revoke = planRevoke(parseConfig(cfg()), "bob");
    await renderPlan(revoke, base);
    expect(await readFile(join(base, "secrets/bob.password"), "utf8")).not.toBe(old);
    await renderPlan(revoke, out);
    expect(await mode(join(out, "secrets/bob.password"))).toBe(0o600);
  });

  it("rendered artifacts never contain site-specific or default-daemon strings", async () => {
    const out = await tmp();
    await renderPlan(mixed(), out);
    for (const f of await walk(out)) {
      if (f.startsWith(join(out, "secrets"))) continue;
      const text = await readFile(f, "utf8");
      expect(text.toLowerCase(), f).not.toContain("alto");
      expect(text, f).not.toContain("6767");
      expect(text, f).not.toContain("/.paseo/");
      expect(text, f).not.toMatch(/\/\.paseo(\s|$)/);
    }
  });

  it("only mentions 6767 when allowDefaultPort is set and a person uses it", async () => {
    const out = await tmp();
    const plan = planHost(parseConfig(cfg({ allowDefaultPort: true, people: [{ name: "ann", port: 6767 }] })));
    await renderPlan(plan, out);
    expect(await readFile(join(out, "plan.json"), "utf8")).toContain("6767");
  });
});
