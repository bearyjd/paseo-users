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
 probes/                 disposable-daemon verification (opt-in)
 test/                   unit tests
 docs/                   findings, threat model, requirements, roadmap
```

The kernel is deliberately **not** shaped as a network service. Admission belongs to the daemon (R1); the kernel is
what an admission provider, a plugin RPC layer and a Path-B provisioning tool would all call. Keeping it free of Paseo
imports is what lets one security core serve topology A (core extension) and topology B (daemon per Unix account).

The plugin directory conventions are Paseo's: only `index.*`, `server/`, `shared/`, `client/` hold code in the plugin
root, and server code never imports client code. `test/` and `probes/` are not loaded by the plugin compiler.

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

- Reusable code: this repo (`paseo-users`). Nothing here names Alto, household usernames, paths or addresses; data
  directory, clock, hasher and stores are injected.
- Core changes: your fork `bearyjd/paseo`, dedicated feature branch — **not created**; awaiting approval (`07`).
- Alto-specific configuration: `alto-config` (currently an empty directory) — **untouched**.
- Running Paseo (host `alto`, port 6767): **not modified**. Probes use temp homes and ephemeral ports.
