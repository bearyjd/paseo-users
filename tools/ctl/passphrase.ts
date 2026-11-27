export const MIN_PASSPHRASE_LENGTH = 12;

// Printable ASCII only, minus characters that systemd's EnvironmentFile parser treats specially (quotes, backslash)
// or that unit and shell tooling may expand ($, %). Whether the daemon accepts every other character is UNVERIFIED.
const ALLOWED = /^[\x20-\x7e]+$/;
const FORBIDDEN = /["'\\$%]/;

/** Returns why a chosen passphrase is not acceptable, or undefined when it is. Never includes the passphrase. */
export function passphraseProblem(passphrase: string, personName?: string): string | undefined {
  if (passphrase.length < MIN_PASSPHRASE_LENGTH) return `passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters`;
  if (personName !== undefined && passphrase.toLowerCase() === personName.toLowerCase()) return "passphrase must not be the person's name";
  if (passphrase !== passphrase.trim()) return "passphrase must not start or end with whitespace";
  if (!ALLOWED.test(passphrase)) return "passphrase may only use printable ASCII characters";
  if (FORBIDDEN.test(passphrase)) return "passphrase must not contain quotes, backslash, $ or % (they are special in the daemon's environment file)";
  return undefined;
}
