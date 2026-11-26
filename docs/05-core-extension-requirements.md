# 05 — Upstream integration requirements (minimal core extension)

> ## Implementation status (feature branch `feat/users-admission`)
>
> Implemented and tested in a separate worktree of your fork, based on upstream `e4dc119df` (v0.17.5). **Local
> commits only; not pushed, not merged, not running on Alto.** Branch `feat/users-admission`:
> `82603e703` R1 admission provider + R8 flags · `41352bc96` R2 caller identity · `2cfaa64ed` provider loaded from
> `PASEO_ADMISSION_MODULE` · `c097d6017` provider-hosted `/api/auth/*` routes.
>
> | Req | Status | Notes / deviations from the proposal below |
> | --- | --- | --- |
> | R1 | **Done** | `AdmissionProvider` (`authenticate`, `http`, `subscribe`). `hello.auth` gains `{kind:"credential"}`. With a provider the shared password and a missing credential admit nobody; the local credential still admits the operator (CLI works). Header-bearer path goes through the provider. Revoke closes live sockets, narrowing applies live. Daemon refuses to start in provider mode without an operator password (HTTP/MCP depend on it) or if the module cannot load. **Deviation:** the pre-auth hook is a general provider-hosted `/api/auth/*` handler, not a single `login`, because the provider must be the only writer of its state. Provider is loaded from env `PASEO_ADMISSION_MODULE` only (no `config.json` field yet). |
> | R2 | **Done** | `context.caller = {principalId, permissions}` for RPC and subscription handlers, derived from the session, never from input. Per-RPC permission declaration was **not** added; plugin RPC still needs `daemon.manage`. |
> | R8 | **Partial** | `principalAdmission` and `pluginCallerIdentity` advertised. `resourceScopedGrants` and `redactedDaemonRead` do not exist yet. |
> | R3, R4, R5, R6, R7 | **Not started** | Resource scoping, path binding, push, per-agent MCP tokens, redacted `daemon.read`. Until R3/R7, developer accounts are **not admitted** (fail closed). |
>
> Verified by 5 new test files in core (admission resolver, transport e2e, plugin caller e2e, module loader, env config; 30 tests) plus the 40 existing auth/admission tests re-run unchanged, `tsc`, and `oxlint`/`oxfmt`. The paseo-users provider is verified against a real daemon built from the branch (`probes/core-branch.probe.ts`).


**Status: R1, R2 and part of R8 are implemented on a local feature branch (see below); everything else is proposal.
Nothing is deployed to Alto.** Intended as a feature branch of `bearyjd/paseo` rebased
on current `getpaseo/paseo` main, shaped so it can be offered upstream.

Design principle: extend what upstream already points at. `docs/permissions.md` states the target model
(principal → grants; credential proves a device/service represents a principal; *future* workspace-scoped
`Grant { permission, resource }`; "operation classification remains inside the authorization module"). The
requirements below implement that sentence, not a parallel system.

## R1 — Principal admission provider (smallest, highest value)

**Problem.** `resolveSessionAdmission` returns `principalId: "owner"` for any credential.

**Change.**
```ts
// authorization/admission-provider.ts (new, ~100 LOC)
interface AdmissionProvider {
  readonly id: string;
  authenticate(credential: HelloCredential, ctx: { remoteAddress?: string; clientId: string }):
    Promise<{ principalId: string; permissions: DaemonPermission[]; scope?: PrincipalScope } | { reject: "incorrect_password" | "forbidden" }>;
  /** called so the daemon can drop sockets when a principal is revoked */
  onRevoke(listener: (principalId: string) => void): void;
}
```
- `hello.auth` gains `{ kind: "credential", token }` (protocol-additive and optional, per
  `docs/protocol-compatibility.md`; old clients unaffected).
- Config `daemon.auth.mode: "password" | "users"`. In `users` mode the shared password and `local-credential`
  no longer grant owner on the network listener; the **local credential keeps working for the local CLI** so the
  operator cannot lock themselves out (and so `paseo` CLI/supervisor keep functioning).
- Provider implementation is **in-daemon** (module loaded by path from config, same trust as plugins) or a
  built-in `users.json` provider; it must not be a plugin subprocess because admission precedes plugin startup
  (`docs/plugins.md`: clients accepted only after plugins settle).
- `WebSocketServer.updatePrincipalPermissions` is wired to `onRevoke` so disable/revoke closes live sessions.
- Pre-auth login: `POST /api/auth/login` (bearer-free route, rate-limited by the provider) returning a login
  token, or a hello `{kind:"login"}` exchange. The app connect flow shows a sign-in step when
  `server_info`/health reports `authMode: "users"`.
- Plugin sockets keep their owner admission (operator trust) — unchanged.

**Closes:** T1, T15; rows 2, 4, 6, 7, 14, 16(login).

## R2 — Caller identity in plugin handler context

**Change.** `PluginHandlerContext` and subscription/hook contexts gain
`caller?: { principalId: string; permissions: readonly DaemonPermission[]; sessionId: string }`, populated by the
daemon from the invoking session (it already knows `session.principalId`). Additive; absent on old daemons.
Allow a plugin to declare an RPC's minimum permission so non-`daemon.manage` principals can call *that* RPC.

**Closes:** rows 3, 4, 15. Lets the plugin host account/admin RPCs safely, keyed on `caller`.

## R3 — Resource-scoped grants (the large item)

**Change.** Implement the `Grant` shape from `docs/permissions.md`: permissions scoped to `{kind:"workspace", ids}`.
Per the leakage inventory (`01-…` §4) enforcement points are:

1. **Inbound** — after `allowsInbound` in `Session.handleRequest` (`session.ts:2521`): a per-message-type
   *resource extractor* in the authorization module (`agentId` → workspace, `terminalId` → workspace, `cwd`/`path`
   → registered workspace via `resolveWorkspaceIdForPath`, `workspaceId`, `repoRoot`). Unmapped types fail closed
   for scoped principals. A types-exhaustiveness test (like the existing `satisfies Record<…>` tables) makes new
   message types un-mergeable without classification.
2. **Outbound** — `Session.emit` / `emitSubscribedEvent` / `publishToSource` (`session.ts:786, 2627, 9575, 9608`):
   drop events whose agent/workspace/terminal is out of scope; includes the legacy direct `onMessageToSource` and
   `sendToClient` paths and the two attention broadcasters.
3. **Listings** — `AgentDirectory.list`, `listFetchWorkspacesEntries`, `handleProjectListRequest`,
   `DirectorySyncService` (per-principal partition, not a shared `VersionedCollection`).
4. **Binary** — terminal output and file transfer frames currently skip `allowsOutbound`; gate at subscribe time and
   on frame emit.
5. **Ownership stamp** — add `{ kind: "user", principalId }` to `AgentOwnerSchema`; agents/workspaces/projects
   created by a scoped principal are stamped and the principal's scope is extended atomically (so creation does
   not require pre-existing grants).
6. Report capability: `server_info.features.resourceScopedGrants` so clients and paseo-users can detect it.

**Closes:** T3; rows 8, 9, 10, 13, 15. Largest and riskiest change; split into reviewable PRs (inbound extractor +
exhaustiveness test first, then listings, then outbound, then binary).

## R4 — Files and paths bound to workspaces

`file_explorer`, `fs.*`, `file_download_token`, `project_icon`, `directory_suggestions`, `project.add`,
`project.create_directory` and `checkout_*` accept an arbitrary absolute `cwd` *(probe)*. For scoped principals
`cwd` must resolve into a granted workspace (use `resolveKnownProjectRoot`, which already exists for
`read_project_config_request`). `project.add`/`create_directory` need a configurable **allowed-roots** list so a
developer can only register paths under their own area. Bind `DownloadTokenStore` entries to the issuing principal.

## R5 — Notifications and push

Associate push tokens with a principal; send only to the principal(s) in scope. Compute attention/presence per
principal.

## R6 — Agent MCP bound to principal and agent

Replace the single per-run capability token with a per-agent token bound to `{principalId, agentId}`; derive
`callerAgentId` from the token, not the query string; scope tools through R3.

## R7 — Redacted `daemon.read`

`get_daemon_config_response`, provider and diagnostics responses expose configuration. Split status/provider
availability from configuration so a developer's `daemon.read` cannot reveal credentials or operator settings.

## R8 — Enforcement capability advertisement

`server_info.features: { principalAdmission, resourceScopedGrants, redactedDaemonRead, pluginCallerIdentity }`.
paseo-users reads these to compute `CoreEnforcement`; it never infers enforcement from its own state. (Maps
1:1 to `server/kernel/daemon-mapping.ts`.)

## Dependency order and minimum for the MVP

```text
R8 ─┐
R1 ─┼─▶ authenticated principals (admin vs developer, independent logins, revoke)      ← MVP items 1,2,3,6,7,8
R2 ─┘
R3 + R4 + R6 + R7 ─▶ "each user sees only their own projects/sessions" safely         ← MVP items 4,5
R5 ─▶ notification isolation (can ship after)
```

If R3 is judged too large for the first release, the honest smaller product is: **R1 + R2 only, administrators
and developers authenticate independently, and the deployment uses topology B** (a daemon per Unix account) so that
isolation comes from the OS rather than R3. See `07-roadmap.md`.

## Interim, no-core-change containment (documented, not implemented here)

Bind the daemon to a unix socket or loopback and put an authenticating reverse proxy in front. This stops
network-level bypass but not a same-uid process and duplicates the message tables (fragile across upstream's fast
protocol drift); recommended only as a stop-gap.
