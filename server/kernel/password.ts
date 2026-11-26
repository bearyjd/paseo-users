import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from "node:crypto";

/**
 * Password hashing: scrypt from node:crypto (RFC 7914), stored as a self-describing string:
 *   $scrypt$ln=17,r=8,p=1$<salt b64url>$<hash b64url>
 * OWASP lists scrypt (N=2^17, r=8, p=1) as an accepted choice when Argon2id is unavailable.
 * node:crypto gains `argon2` in Node 24.7; the `$scrypt$` prefix lets a later version add
 * `$argon2id$` and rehash on login (see needsRehash) without a flag day.
 */
export interface ScryptParams {
  ln: number;
  r: number;
  p: number;
}

export const DEFAULT_SCRYPT_PARAMS: ScryptParams = { ln: 17, r: 8, p: 1 };
const KEY_BYTES = 32;
const SALT_BYTES = 16;

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 256;
// A deliberately tiny list: the point is to stop the worst choices, not to be a breach corpus.
const TRIVIAL = new Set(["password1234", "123456789012", "qwertyuiop12", "paseopaseo12", "letmein12345"]);

export class PasswordPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PasswordPolicyError";
  }
}

/** NIST SP 800-63B style: length over composition rules. Unicode is allowed. */
export function assertPasswordAcceptable(password: string, context: { username?: string } = {}): void {
  if (password.length < PASSWORD_MIN_LENGTH) {
    throw new PasswordPolicyError(`Password must be at least ${PASSWORD_MIN_LENGTH} characters`);
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    throw new PasswordPolicyError(`Password must be at most ${PASSWORD_MAX_LENGTH} characters`);
  }
  const lowered = password.toLowerCase();
  if (TRIVIAL.has(lowered) || new Set(password).size < 5) {
    throw new PasswordPolicyError("Password is too easy to guess");
  }
  if (context.username && lowered.includes(context.username.toLowerCase())) {
    throw new PasswordPolicyError("Password must not contain the username");
  }
}

function scryptAsync(password: string, salt: Buffer, params: ScryptParams): Promise<Buffer> {
  const N = 2 ** params.ln;
  const options: ScryptOptions = {
    N,
    r: params.r,
    p: params.p,
    // scrypt needs 128*N*r bytes; Node's default cap (32 MiB) is too small for N=2^17.
    maxmem: 128 * N * params.r * 2 + 1024 * 1024,
  };
  return new Promise((resolve, reject) => {
    scrypt(password.normalize("NFKC"), salt, KEY_BYTES, options, (error, key) =>
      error ? reject(error) : resolve(key),
    );
  });
}

/** Bounds concurrent scrypt work so a login flood cannot exhaust memory (each hash is ~128 MiB at N=2^17). */
class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];
  constructor(private readonly limit: number) {}
  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.active++;
    try {
      return await task();
    } finally {
      this.active--;
      this.waiters.shift()?.();
    }
  }
}

export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(password: string, encoded: string): Promise<boolean>;
  needsRehash(encoded: string): boolean;
}

export function createPasswordHasher(
  options: { params?: ScryptParams; maxConcurrent?: number } = {},
): PasswordHasher {
  const params = options.params ?? DEFAULT_SCRYPT_PARAMS;
  const gate = new Semaphore(options.maxConcurrent ?? 2);
  return {
    async hash(password) {
      const salt = randomBytes(SALT_BYTES);
      const key = await gate.run(() => scryptAsync(password, salt, params));
      return `$scrypt$ln=${params.ln},r=${params.r},p=${params.p}$${salt.toString("base64url")}$${key.toString("base64url")}`;
    },
    async verify(password, encoded) {
      const parsed = parseEncoded(encoded);
      if (!parsed) return false;
      const key = await gate.run(() => scryptAsync(password, parsed.salt, parsed.params));
      return key.length === parsed.hash.length && timingSafeEqual(key, parsed.hash);
    },
    needsRehash(encoded) {
      const parsed = parseEncoded(encoded);
      if (!parsed) return true;
      return (
        parsed.params.ln < params.ln || parsed.params.r < params.r || parsed.params.p < params.p
      );
    },
  };
}

function parseEncoded(encoded: string): { params: ScryptParams; salt: Buffer; hash: Buffer } | null {
  const parts = encoded.split("$");
  if (parts.length !== 5 || parts[0] !== "" || parts[1] !== "scrypt") return null;
  const match = /^ln=(\d{1,2}),r=(\d{1,2}),p=(\d{1,2})$/.exec(parts[2] ?? "");
  if (!match) return null;
  const params = { ln: Number(match[1]), r: Number(match[2]), p: Number(match[3]) };
  // Refuse stored parameters that would let a tampered record force a huge allocation.
  if (params.ln < 10 || params.ln > 20 || params.r < 1 || params.r > 16 || params.p < 1 || params.p > 4) {
    return null;
  }
  const salt = Buffer.from(parts[3] ?? "", "base64url");
  const hash = Buffer.from(parts[4] ?? "", "base64url");
  if (salt.length < 8 || hash.length !== KEY_BYTES) return null;
  return { params, salt, hash };
}
