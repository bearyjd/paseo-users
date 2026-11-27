# AGENTS.md

Guidance for AI coding agents working in this repository. (`CLAUDE.md` is identical in intent.)

## What this is

`paseo-users`: identity and authorization for multi-user Paseo. Start with `docs/ARCHITECTURE.md`.

## Commands

```bash
npm run typecheck          # always after changes
npm test                   # unit tests (fast; real scrypt with cheap params)
npm run check              # both
npm run build                       # emit dist/ (the daemon loads dist/server/admission-entry.js)
PASEO_PROBE=1 npm run test:probes   # disposable-daemon probes (needs `paseo` on PATH)
PASEO_PROBE=1 PASEO_CORE_DIR=<fork worktree> npm run test:probes   # also the core-branch end-to-end
```

## Hard rules

- **Never touch a production Paseo.** Do not restart, stop, reload or install into the daemon on port 6767 or read
  `~/.paseo` (it contains credentials). Probes use temp homes and ephemeral ports through `probes/daemon-harness.ts`.
- **Never run `paseo daemon stop|restart` without an explicit disposable `--home`.**
- **Do not modify Paseo core, the maintainer's fork, a private deployment-config repository, or any deployment** without explicit user approval.
- **No stub authentication.** Anything that does not enforce must say `enforcement: "none"`.
- **Fail closed.** Unknown resource, role, action or missing core capability = deny / grant nothing.
- **No secrets in the repo, tests, logs or audit records.** Tests use synthetic credentials.
- Do not hardcode host names, usernames, paths or addresses.
- Do not add runtime dependencies without justification (current: Node built-ins + `zod`).

Releasing and registry listing: `docs/14-releasing.md`.

## Layout and conventions

See `docs/ARCHITECTURE.md`. Plugin code only in `server/`, `shared/`, `client/`, `index.*`. Kernel has no Paseo
imports. Validate persisted and wire data with Zod. Authorization decisions take a server-resolved `Principal`,
never a client-supplied user id.

## Writing docs

Plain, short, second person. State what is verified and where (file path or probe). Mark unverified claims as such.
Update the capability matrix and threat model when a blocker is closed.
