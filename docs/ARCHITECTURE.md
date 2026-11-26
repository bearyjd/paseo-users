# Architecture and repository structure

Read in this order: `01` current Paseo auth → `02` capability matrix → `03` security architecture → `04` threat model →
`05` core-extension requirements → `06` data model → `07` roadmap/decision → `08` Profiles contract → `10` testing.

## Components

```text
 shared/                 Zod contracts used by every runtime: permissions, data model, Profiles contract, status RPC
 server/kernel/          Identity + authorization kernel. NO Paseo dependency. Pure TS + node:crypto/fs.
   kernel.ts             UsersKernel: login, sessions, invitations, users, projects, session ownership, allowances
   authz.ts              Pure, deny-by-default decisions over a resolved Principal
   password.ts tokens.ts rate-limit.ts audit.ts json-store.ts migrations.ts clock.ts
   daemon-mapping.ts     users permissions → Paseo daemon permissions; FAILS CLOSED
   context.ts            builds the Profiles context (UsersContextV1)
 server/status.ts        plugin status (always reports what core cannot yet enforce)
 index.server.ts         plugin entry: one read-only RPC. No account-mutating RPC until caller identity exists (R2)
 paseo-plugin.json       plugin manifest
 client/                 (slice 3) mobile-first admin/account UI using @getpaseo/plugin/client/ui — not yet written
 tools/ctl/               Provisioning planner for the daemon-per-person mode (plans and renders; never executes by default)
 probes/                 disposable-daemon verification (opt-in)
 test/                   unit tests
 docs/                   findings, threat model, requirements, roadmap
```

The kernel is deliberately **not** shaped as a network service. Admission belongs to the daemon (R1); the kernel is
what an admission provider, a plugin RPC layer and a Path-B provisioning tool would all call. Keeping it free of Paseo
imports is what lets one security core serve topology A (core extension) and topology B (daemon per Unix account).

The plugin directory conventions are Paseo's: only `index.*`, `server/`, `shared/`, `client/` hold code in the plugin
root, and server code never imports client code. `test/` and `probes/` are not loaded by the plugin compiler.

## Two modes, one package

| Mode | What it is | Needs core changes | Status |
| --- | --- | --- | --- |
| **Daemon per person** (priority) | One Paseo daemon per person, each with its own `PASEO_HOME`, port and password. Isolation strategy per person: `same-user` (shared Linux user and LLM logins, data separation only) or `unix-account` (own Linux user, OS isolation, separate LLM logins). Provisioned by `tools/ctl`, runbook `11-...` | **No** | Planner built and tested; never applied to a real host |
| **Single daemon, many users** | One daemon, one login, per-user visibility, via the identity kernel and a core admission provider | **Yes** (`feat/users-admission`, local) | Administrators only; developers refused until resource scoping exists |

The identity kernel serves the second mode. The first mode does not depend on it.

## Separation of concerns

| Layer | Owner | Does not do |
| --- | --- | --- |
| Identity | kernel (`UsersKernel.login/authenticate`) | decide permissions |
| Authorization | `authz.ts` | authenticate; trust client-supplied ids |
| Profile | Profiles plugin | grant anything (contract `08`) |
| Sandbox | execution layer (later) | decide who may use it |
| Host | Paseo / connected hosts | — |
| Credential broker | separate component (later) | live in user records |

## Deployment separation (brief §15)

- Reusable code: this repo (`paseo-users`). Nothing here names a host, household usernames, paths or addresses; data
  directory, clock, hasher and stores are injected.
- Core changes: a feature branch of the maintainer's fork (`feat/users-admission`) — **created locally, not pushed**; see `05`.
- Host-specific configuration: belongs in the operator's own private deployment-config repository — **not part of this repo**.
- Any running Paseo daemon: **never modified**. Probes use temp homes and ephemeral ports.
