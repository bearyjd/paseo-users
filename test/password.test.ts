import { describe, expect, it } from "vitest";
import {
  PasswordPolicyError,
  assertPasswordAcceptable,
  createPasswordHasher,
  DEFAULT_SCRYPT_PARAMS,
} from "../server/kernel/index.js";
import { cheapHasher } from "./helpers.js";

describe("password storage", () => {
  it("never stores the plaintext and uses a self-describing scrypt string", async () => {
    const encoded = await cheapHasher().hash("a long enough secret phrase");
    expect(encoded).toMatch(/^\$scrypt\$ln=10,r=8,p=1\$[\w-]+\$[\w-]+$/);
    expect(encoded).not.toContain("secret");
  });

  it("verifies the right password and rejects wrong ones", async () => {
    const hasher = cheapHasher();
    const encoded = await hasher.hash("a long enough secret phrase");
    expect(await hasher.verify("a long enough secret phrase", encoded)).toBe(true);
    expect(await hasher.verify("a long enough secret phrasf", encoded)).toBe(false);
    expect(await hasher.verify("", encoded)).toBe(false);
  });

  it("salts every hash", async () => {
    const hasher = cheapHasher();
    expect(await hasher.hash("same password value")).not.toBe(await hasher.hash("same password value"));
  });

  it("rejects malformed or tampered stored hashes instead of throwing or allocating", async () => {
    const hasher = cheapHasher();
    const good = await hasher.hash("a long enough secret phrase");
    for (const bad of ["", "plain", "$scrypt$ln=99,r=8,p=1$AAAAAAAAAAAAAAAA$AAAA", good.replace("ln=10", "ln=30"), good.slice(0, -4)]) {
      expect(await hasher.verify("a long enough secret phrase", bad)).toBe(false);
    }
  });

  it("flags hashes made with weaker parameters for rehash on next login", async () => {
    const weak = await cheapHasher().hash("a long enough secret phrase");
    const strong = createPasswordHasher({ params: { ln: 12, r: 8, p: 1 } });
    expect(strong.needsRehash(weak)).toBe(true);
    expect(cheapHasher().needsRehash(weak)).toBe(false);
  });

  it("production defaults meet the OWASP scrypt minimum (N=2^17, r=8, p=1)", () => {
    expect(DEFAULT_SCRYPT_PARAMS).toEqual({ ln: 17, r: 8, p: 1 });
  });

  it("works with the production parameters", async () => {
    const hasher = createPasswordHasher();
    const encoded = await hasher.hash("production cost check phrase");
    expect(await hasher.verify("production cost check phrase", encoded)).toBe(true);
  });

  it("enforces length and rejects trivial or username-containing passwords", () => {
    expect(() => assertPasswordAcceptable("short")).toThrow(PasswordPolicyError);
    expect(() => assertPasswordAcceptable("a".repeat(300))).toThrow(PasswordPolicyError);
    expect(() => assertPasswordAcceptable("aaaaaaaaaaaaaaaa")).toThrow(PasswordPolicyError);
    expect(() => assertPasswordAcceptable("my-name-is-alice-yes", { username: "alice" })).toThrow(PasswordPolicyError);
    expect(() => assertPasswordAcceptable("correct horse battery staple")).not.toThrow();
  });
});
