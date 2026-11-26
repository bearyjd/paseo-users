# 07 — MVP implementation plan and roadmap

## Priority update (owner, later)

**Daemon per person under the current Linux user comes first**, then separate Linux users, as two isolation strategies of
one modular tool (`tools/ctl`, runbook `11-daemon-per-person-runbook.md`). The single-daemon core extension stays as the
second mode. Applying anything to the target host still needs explicit approval. Sharing a project between two same-user daemons
works at the directory level (probe-verified), not at the session level.

## Decision recorded (owner, during slice 2 kickoff)

- **One daemon, shared LLM accounts.** Both people use the *same* provider logins (the daemon's configured
  Claude/Codex/etc. accounts). A paseo-users user is a **super-profile**: identity + per-user view (projects,
  sessions, preferences) + allowances over those shared providers. No per-user Unix accounts, no per-user provider
  credentials.
- **Path A is the direction.** Path B (daemon per Unix account) is shelved; it needs separate provider logins per
  account, which the owner does not want. Approved scope: core branch for R8 + R1 + R2 on a disposable instance only.
  Still not approved: any change on the target host.
- Consequences are recorded in `03-security-architecture.md` §5 and `04-threat-model.md` T19.

## Original decision framing (superseded by the above)

The research shows the brief's MVP (items 4, 5, 8: each user sees only their own sessions; direct RPC cannot bypass)
cannot be met by a plugin alone, and that same-uid execution defeats application-level separation (matrix row 18).
Two ways forward; they share the identity kernel built in slice 1.

| | **Path A — core extension** (R1–R8, shared daemon) | **Path B — daemon per Unix account** (no core change) |
| --- | --- | --- |
| What you get | One app login, one daemon, shared projects, per-user views | Real isolation now; two daemons on the target host (e.g. `:6767` operator, `:6768` son), each with own uid/home/password/credentials |
| Cost | R3 is a multi-PR upstream-scale change; fork drift (44 commits behind) | Provisioning tooling + operator runbook; no live shared workspace |
| Security claim | API-level only until agents are wrapped into per-user accounts/containers | OS-enforced separation |
| Approval needed for | Modifying fork/core | Creating Unix accounts, systemd user units on the target host (system changes) |

**Recommendation.** Do **B first** for the household deployment (it is the only option that satisfies "do not confuse
application-level separation with OS isolation" today), and pursue **A in stages** (R8 → R1 → R2 first: independent
authenticated logins and revocation; R3 last) for the community-facing plugin. Slice 1 serves both.

## Slices

| # | Slice | Status |
| --- | --- | --- |
| 0 | Research, capability matrix, threat model, architecture docs, repo, CI | **Done** (this repo) |
| 1 | **Identity & authorization kernel**: accounts, scrypt, login sessions, expiry/revoke, throttling, invitations/reset, roles, project/session isolation decisions, allowances, audit, JSON store + migration/rollback, daemon-permission mapping (fail-closed), Profiles contract; honest plugin status RPC; disposable-daemon blocker probes | **Done**: 74 unit tests + 10 probes (`10-…`) |
| 2 | Core R8 + R1 + R2 on a feature branch of your fork, disposable instance; revoke closes live sockets; shared-secret bypass closed | **Done on branch `feat/users-admission`** (local, not pushed). **Administrators only**: developers are refused (fail closed) until R3/R7 |
| 3 | Account UI (mobile-first, Paseo UI kit), app sign-in step, Profiles RPCs. Account administration is served by the provider's `/api/auth/*` (in-daemon, single writer); a plugin may front it using `caller`, but must not write the store | Unblocked by slice 2; not started |
| 4 | R3/R4/R6/R7: resource scoping, path binding, per-agent MCP tokens, redacted daemon.read; full cross-user acceptance suite | Blocked on slice 2; largest |
| 5 | Execution layer: workspace → Unix account/rootless Podman mapping via `wrap`; credential-reference broker interface; notifications (R5) | After 4 (or immediately for Path B) |
| 6 | OIDC / passkeys via `IdentityProvider`; device pairing ↔ user; invitations over QR | Later |
| B1 | Daemon-per-person provisioning: `tools/ctl` planner (same-user and unix-account strategies), runbook `11-...` | **Built** (plan/render only, never applied). Applying it to a real host needs approval |

## MVP acceptance mapping (brief §12)

| MVP item | Slice | Today |
| --- | --- | --- |
| 1 admin initializes multi-user | 1 (kernel) / 2 (daemon) | Kernel ✔ tested; daemon ✘ |
| 2 admin creates developer | 1 | Kernel ✔ |
| 3 both authenticate independently | 1 / 2 | **Administrators ✔ on the branch** (distinct principal per login session). Developers refused until R3/R7 |
| 4 own coding sessions | 4 | Decisions ✔ in kernel; daemon enforcement ✘ |
| 5 sees only authorized projects/sessions | 4 | Same |
| 6 developer cannot reach admin ops | 1 / 2 | Kernel ✔; plugin mgmt already gated by `daemon.manage` ✔ |
| 7 admin revokes developer | 1 / 2 | ✔ on the branch for any account: disable/revoke closes its live sockets in <2 s (probe), per-device revoke closes only that device. A *developer* cannot sign in yet |
| 8 direct daemon/RPC cannot bypass | 2 (+4) | **Partly met on the branch**: shared secret/header/anonymous rejected, forged tokens rejected, HTTP outside `/api/auth` still needs the operator secret. **Not met**: a same-uid agent can read `local-credential`; `/mcp/agents` token is shared (R6) |
| 9 single-user unchanged | all | ✔ plugin enforces nothing and mutates no state; daemon untouched |
| 10 ready for Profiles/sandboxes | 1 | ✔ contract + `unixAccount` + sandbox allowances |

**Do not call this release secure multi-tenancy.** Items 4 and 5 are unmet, item 8 only partly, and developer sign-in is deliberately blocked.

## Approvals required (none obtained or assumed)

1. ~~Create a feature branch of `bearyjd/paseo` and implement R8/R1/R2 (slice 2).~~ **Approved and done locally** (not pushed; pushing needs a separate OK).
2. Any change to production authentication on the target host (switching to `users` mode, rotating passwords).
3. Creating accounts, migrating state, or installing this plugin on the target host's running daemon.
4. Path B: creating Unix accounts and systemd units; opening additional ports.
5. Publishing the repository to GitHub (not done; the repo is local only).
