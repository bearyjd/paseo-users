# Security policy

## Status

Pre-release and **not a security boundary for a running Paseo daemon** (see README and `docs/04-threat-model.md`).
Do not rely on it to separate mutually untrusting users.

## Supported versions

Only the latest release (0.1.x) is looked at. 0.1.0 is a pre-release that enforces nothing on stock Paseo.

## Reporting a vulnerability

Please report privately. GitHub private vulnerability reporting is **not enabled** on the repository yet, so contact the
maintainer directly through the GitHub profile of the repository owner (`bearyjd`). Do not open public issues for
exploitable findings, and do not put details in a public issue asking for a contact. Include affected version, a
reproduction against a disposable instance with synthetic credentials, and impact. We aim to acknowledge within
7 days.

## Scope

In scope: the kernel (`server/kernel`), shared contracts, plugin entry, store format and migrations.
Out of scope: Paseo core (report upstream at getpaseo/paseo), malicious plugins (operator trust), local root.

## Rules for contributors and test authors

- Never commit passwords, tokens, SSH keys, `.env` files or production config. Tests use synthetic values only.
- Never run security or destructive tests against a production Paseo. Use a temp `PASEO_HOME`, loopback, an
  ephemeral port (never 6767) and a synthetic password. `probes/daemon-harness.ts` enforces this.
- No stub authentication that could be mistaken for a boundary: unenforced features must report `enforcement: "none"`.
