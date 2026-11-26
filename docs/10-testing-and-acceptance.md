# 10 — Testing and acceptance criteria

## Layers

| Layer | Command | Runs against | In CI |
| --- | --- | --- | --- |
| Unit / kernel | `npm test` | In-memory and temp-dir stores, real scrypt (cheap params + one production-param test), fake clock | ✔ |
| Typecheck | `npm run typecheck` | `tsc --noEmit`, strict + `noUncheckedIndexedAccess` | ✔ |
| Probes | `PASEO_PROBE=1 npm run test:probes` | **Disposable daemon** (temp `PASEO_HOME`, loopback ephemeral port, relay off, synthetic password, no agents): blocker confirmation + plugin-load check; plus a static SDK check | daemon probes opt-in (need a Paseo install); the static SDK check always runs |
| Core-branch end-to-end | `PASEO_PROBE=1 PASEO_CORE_DIR=<worktree> npm run test:probes` (after `npm run build` here and the server build there) | **Real daemon built from `feat/users-admission`** loading this provider via `PASEO_ADMISSION_MODULE`, driven over HTTP and WebSocket (`probes/core-branch.probe.ts`, 11 tests) | opt-in |
| Core unit/e2e (in the fork) | `npx vitest run <file>` per Paseo's rules | In-process daemon with a fake provider | fork CI (not run) |

Safety rules for any test touching a daemon: temp home only; never port 6767; never `paseo daemon stop/restart`
without an explicit disposable `--home`; synthetic credentials; teardown kills only the spawned process group.
Production Paseo is never a test target. `probes/daemon-harness.ts` enforces the first three.

## Coverage vs. the brief's §13 list

Status: ✔ implemented and passing · ◐ kernel-level only (daemon enforcement pending) · ✘ not yet possible.

| Required test area | Status | Where |
| --- | --- | --- |
| Authentication success and failure | ✔ | `test/auth.test.ts` |
| Password storage | ✔ | `test/password.test.ts`, `auth.test.ts` (no plaintext/hash leakage) |
| Session expiration and revocation | ✔ | `auth.test.ts` (idle, absolute, logout, admin revoke, password change) |
| Disabled accounts | ✔ | `auth.test.ts` (equal error, sessions killed, no resurrection) |
| Role enforcement | ✔ | `authz.test.ts` (all admin ops denied to developer) |
| Privilege escalation | ✔ | `authz.test.ts` (self-promotion, delegation, takeover, last admin) |
| Cross-user session access | ◐ | `authz.test.ts` decisions; daemon handlers don't call them (R3) |
| Cross-user project access | ◐ | same |
| Direct RPC authorization bypass | ◐ | Against the installed 0.17.4 daemon the bypass is confirmed (`blockers.probe.ts`). On the branch: shared password, header bearer, anonymous and forged tokens are rejected (`core-branch.probe.ts`). Not covered: same-uid agent reading `local-credential`, shared `/mcp/agents` token |
| Unauthorized WebSocket subscriptions | ✘ | needs R3 outbound filtering; probe shows global visibility |
| Unauthorized terminal and file access | ✘ | probe shows arbitrary-`cwd` file listing; needs R4 |
| Unauthorized profile and sandbox selection | ✔ (decision) | `context-and-mapping.test.ts` |
| Credential disclosure | ✔ | `authz.test.ts` (store + audit scanned for secrets) |
| Plugin management restrictions | ✔ today / ◐ | probe: non-`daemon.manage` sessions denied `plugin.*`; mapping never grants it to developers |
| Single-user compatibility | ◐ | `probes/plugin-load.probe.ts`: installed in a disposable daemon, the plugin loads under Paseo's real compiler, registers one read-only RPC, no mutating RPC, reports `enforcement:"none"`. Admission/permissions are untouched because no core change exists. Not yet tested: a long-running daemon with real agents and the app UI |
| Migration and rollback | ✔ | `test/store.test.ts` (backup, restore bytes, failing step, invalid shape, newer-version refusal) |
| Integration tests on an isolated instance | ◐ | probes only; full acceptance after slice 2 |

## Acceptance criteria for "secure multi-user" (must all hold before the claim is made)

1. A developer principal cannot, over any transport (WS, `/mcp/agents`, file download, service proxy, relay), list,
   read, subscribe to or control another user's agents, workspaces, terminals, files, schedules or notifications.
2. A request with a stale, revoked, expired or forged credential is rejected at admission; live sockets are closed
   within one second of revoke/disable.
3. Developers never hold `daemon.manage`/`access.manage`/`tunnel.manage`/`automation.manage`/`hub.execute`.
4. Every inbound/outbound message type is classified for scope (exhaustiveness test fails the build otherwise).
5. Agents of different users run under different Unix accounts or containers, and a developer agent **cannot read**
   the operator's `PASEO_HOME`, `users.json` or credentials (tested by attempting the read from a wrapped agent).
6. No credential value appears in user/profile records, audit logs, agent snapshots or logs.
7. Single-user deployments (feature off) behave byte-for-byte as before: same admission, same permissions.
8. Migration forward and rollback tested on a copy of real-shaped data, never production.

Until 1, 2, 4, 5 and the corresponding disposable-instance tests pass, documentation and UI must say the release
**does not provide secure multi-tenancy**.

## Unverified (honest list)

- The core branch was verified with scoped installs of the server workspaces only. The full upstream suite, the app, the CLI package (its build failed here on a `commander` typings mismatch caused by the scoped install) and the desktop shell were **not** run. Run Paseo CI before any PR.
- Open sockets outlive login-token idle expiry: the token is checked at connect and on API calls, not on every frame. Revocation (disable, logout, admin revoke) closes sockets; plain expiry does not.
- Provider-mode behaviour with the relay, Hub and connected-host paths beyond reading source.

- Behavior on Paseo versions other than 0.17.4 runtime / 0.17.5 source.
- Real-world scrypt latency on Alto's CPU (N=2^17 measured ~230 ms on the development machine).
- Whether plugin processes can read `users.json` by design on Alto (they can; same uid) — covered by T9, not tested.
- Relay, Hub and connected-host admission paths beyond reading source.
- The mobile app's connect flow (needed for R1's sign-in step); not inspected.
- Windows/macOS file-mode semantics (the store sets POSIX modes only).
