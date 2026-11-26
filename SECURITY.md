# Security policy

## Status

Pre-release and **not a security boundary for a running Paseo daemon** (see README and `docs/04-threat-model.md`).
Do not rely on it to separate mutually untrusting users.

## Reporting a vulnerability

Please report privately: open a GitHub "Report a vulnerability" advisory on the repository once it is published, or
contact the maintainer directly. Do not open public issues for exploitable findings. Include affected version, a
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
