# paseo-users

Multi-user authentication and access management for [Paseo](https://paseo.sh): accounts, roles, sessions,
per-user project/session authorization and a versioned contract for the Profiles plugin. Self-hosted, no cloud or
external identity provider required. Apache-2.0.

> ## ⚠️ Status: pre-release. Not deployed, and not a boundary for developers yet.
>
> On the local core branch (`feat/users-admission`, not pushed) administrators sign in as distinct principals and
> the shared-password bypass is closed. **Developer accounts are refused** until core can scope resources.
> Against stock Paseo, installing the plugin enforces nothing.
>
> Paseo today admits one shared principal (`owner`) with every permission, plugin RPC handlers receive no caller
> identity, and no handler checks resource ownership. A plugin cannot fix any of that. What exists here is the
> **identity and authorization kernel** (tested) and a **verified list of the Paseo core changes** needed before
> any login screen would be a security boundary. Installing the plugin enforces nothing and says so
> (`users.status.get` → `enforcement: "none"`).
>
> **Do not describe this as secure multi-tenancy.** Even with the core changes, agents running under the same Unix
> account can read each other's files; real isolation needs separate accounts, containers or VMs.
> See `docs/02-sdk-capability-matrix.md` and `docs/04-threat-model.md`.

## What works now

- Accounts with scrypt password hashes; admin-created accounts, invitations and admin-assisted resets.
- Login sessions: 256-bit tokens (hash stored), idle and absolute expiry, per-device revoke, revoke-all.
- Brute-force protection, equal-work failures, audit log.
- Roles → permissions (`administrator`, `developer`), delegation bound, last-admin guard.
- Project ownership/sharing and coding-session ownership decisions; revoking a share cuts dependent sessions.
- Admin-managed allowances for profiles, sandboxes, providers, credential **references**, hosts.
- Fail-closed mapping to Paseo daemon permissions; read-only Profiles context + deny-by-default request evaluator.
- JSON store with atomic writes, 0600 files, migration with backup and rollback.
- 90 unit tests; 21 probes: blockers on stock Paseo, plugin load, and 11 end-to-end checks on a daemon built from the core branch.

## What does not work yet

Everything that needs the daemon to cooperate: authenticating connections, per-user listings/events/terminals/files,
live-socket revocation, login/admin UI, device pairing ↔ user. See `docs/05-core-extension-requirements.md`
(proposal only; **no Paseo core code has been changed**) and `docs/07-roadmap.md` for the decision on how to proceed.

## Develop

```bash
npm install
npm run check                       # typecheck + unit tests
PASEO_PROBE=1 npm run test:probes   # needs `paseo` on PATH; starts a DISPOSABLE daemon (temp home, loopback, ephemeral port)
```

Probes never touch `~/.paseo`, port 6767 or a running daemon. Install into a disposable daemon only, e.g. with a temp
`PASEO_HOME` and `pluginsEnabled`; do not install on a production daemon until `docs/07-roadmap.md` approvals exist.

## Documentation

`docs/ARCHITECTURE.md` indexes everything: current Paseo auth architecture, SDK capability matrix, security
architecture, threat model, upstream requirements, data model, roadmap, Profiles contract, test plan.
