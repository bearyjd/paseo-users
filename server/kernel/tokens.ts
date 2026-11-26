import { createHash, randomBytes } from "node:crypto";

/**
 * Bearer tokens are 256 random bits. Only their SHA-256 is stored: the input is high entropy,
 * so a fast hash is correct here (a slow KDF would add cost without adding security), and a
 * leaked store does not yield usable tokens. The prefix makes leaked tokens greppable.
 */
export type TokenKind = "session" | "invitation";
const PREFIX: Record<TokenKind, string> = { session: "pus_", invitation: "pui_" };

export function generateToken(kind: TokenKind): string {
  return PREFIX[kind] + randomBytes(32).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function looksLikeToken(kind: TokenKind, value: string): boolean {
  return value.startsWith(PREFIX[kind]) && value.length === PREFIX[kind].length + 43;
}

export function generateId(): string {
  return randomBytes(12).toString("base64url");
}
