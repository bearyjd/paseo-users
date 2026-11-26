# 07 — MVP implementation plan and roadmap

## Decision recorded (owner, during slice 2 kickoff)

- **One daemon, shared LLM accounts.** Both people use the *same* provider logins (the daemon's configured
  Claude/Codex/etc. accounts). A paseo-users user is a **super-profile**: identity + per-user view (projects,
  sessions, preferences) + allowances over those shared providers. No per-user Unix accounts, no per-user provider
  credentials.
- **Path A is the direction.** Path B (daemon per Unix account) is shelved; it needs separate provider logins per
  account, which the owner does not want. Approved scope: core branch for R8 + R1 + R2 on a disposable instance only.
  Still not approved: any change on Alto.
- Consequences are recorded in `03-security-architecture.md` §5 and `04-threat-model.md` T19.

## Original decision framing (superseded by the above)

The research shows the brief's MVP (items 4, 5, 8: each user sees only their own sessions; direct RPC cannot bypass)
cannot be met by a plugin alone, and that same-uid execution defeats application-level separation (matrix row 18).
Two ways forward; they share the identity kernel built in slice 1.

| | **Path A — core extension** (R1–R8, shared daemon) | **Path B — daemon per Unix account** (no core change) |
| --- | --- | --- |
| What you get | One app login, one daemon, shared projects, per-user views | Real isolation now; two daemons on Alto (e.g. `:6767` operator, `:6768` son), each with own uid/home/password/credentials |
| Cost | R3 is a multi-PR upstream-scale change; fork drift (44 commits behind) | Provisioning tooling + operator runbook; no live shared workspace |
| Security claim | API-level only until agents are wrapped into per-user accounts/containers | OS-enforced separation |
| Approval needed for | Modifying fork/core | Creating Unix accounts, systemd user units on Alto (system changes) |

**Recommendation.** Do **B first** for the household deployment (it is the only option that satisfies "do not confuse
application-level separation with OS isolation" today), and pursue **A in stages** (R8 → R1 → R2 first: independent
authenticated logins and revocation; R3 last) for the community-facing plugin. Slice 1 serves both.

## Slices

| # | Slice | Status |
| --- | --- | --- |
| 0 | Research, capability matrix, threat model, architecture docs, repo, CI | **Done** (this repo) |
| 1 | **Identity & authorization kernel**: accounts, scrypt, login sessions, expiry/revoke, throttling, invitations/reset, roles, project/session isolation decisions, allowances, audit, JSON store + migration/rollback, daemon-permission mapping (fail-closed), Profiles contract; honest plugin status RPC; disposable-daemon blocker probes | **Done**: 74 unit tests + 10 probes (`10-…`) |
| 2 | Core R8 + R1 + R2 on a feature branch of your fork, disposable instance, admin & developer log in independently; revoke closes live sockets; direct-bypass tests | **Needs approval** (modifies Paseo core) |
| 3 | Plugin RPCs (`users.*`) keyed on `caller`; admin/account UI (mobile-first, Paseo UI kit); Profiles RPCs | Blocked on slice 2 (R2) |
| 4 | R3/R4/R6/R7: resource scoping, path binding, per-agent MCP tokens, redacted daemon.read; full cross-user acceptance suite | Blocked on slice 2; largest |
| 5 | Execution layer: workspace → Unix account/rootless Podman mapping via `wrap`; credential-reference broker interface; notifications (R5) | After 4 (or immediately for Path B) |
| 6 | OIDC / passkeys via `IdentityProvider`; device pairing ↔ user; invitations over QR | Later |
| B1 | Path B tooling: `paseo-users-ctl` provisioning (create account, systemd user unit, port, password, revoke), runbook in `alto-config` | **Needs approval** (system changes on Alto) |

## MVP acceptance mapping (brief §12)

| MVP item | Slice | Today |
| --- | --- | --- |
| 1 admin initializes multi-user | 1 (kernel) / 2 (daemon) | Kernel ✔ tested; daemon ✘ |
| 2 admin creates developer | 1 | Kernel ✔ |
| 3 both authenticate independently | 1 / 2 | Kernel ✔; at daemon ✘ (one principal) |
| 4 own coding sessions | 4 | Decisions ✔ in kernel; daemon enforcement ✘ |
| 5 sees only authorized projects/sessions | 4 | Same |
| 6 developer cannot reach admin ops | 1 / 2 | Kernel ✔; plugin mgmt already gated by `daemon.manage` ✔ |
| 7 admin revokes developer | 1 / 2 | Kernel ✔; live-socket drop ✘ |
| 8 direct daemon/RPC cannot bypass | 2 (+4) | **✘ Blocker, probe-confirmed** |
| 9 single-user unchanged | all | ✔ plugin enforces nothing and mutates no state; daemon untouched |
| 10 ready for Profiles/sandboxes | 1 | ✔ contract + `unixAccount` + sandbox allowances |

**Do not call this release secure multi-tenancy.** Items 3 (at the daemon), 4, 5, 8 are unmet.

## Approvals required (none obtained or assumed)

1. Create a feature branch of `bearyjd/paseo` and implement R8/R1/R2 (slice 2).
2. Any change to production authentication on Alto (switching to `users` mode, rotating passwords).
3. Creating accounts, migrating state, or installing this plugin on Alto's running daemon.
4. Path B: creating Unix accounts and systemd units; opening additional ports.
5. Publishing the repository to GitHub (not done; the repo is local only).
