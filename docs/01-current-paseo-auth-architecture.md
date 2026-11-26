# 01 — Current Paseo authentication and authorization architecture

Verified against upstream Paseo **v0.17.5** (`origin/main` at `e4dc119d`, snapshot taken 2026-11-26) and the
installed **0.17.4** runtime. Citations are `packages/<pkg>/src/...` paths in that snapshot. Everything marked
*(probe)* was also confirmed against a disposable daemon by `probes/blockers.probe.ts`.

> Your local checkout `~/workspace/paseo` (branch `test/combined-local`) is 44 commits behind upstream main.
> Re-verify this document when that fork is rebased.

## 1. Summary

Paseo authorizes **message types**, not **resources**, and has **one human principal**.

| Question | Answer today |
| --- | --- |
| How many principals can a person authenticate as? | One: `owner`. Password and local-credential admission both return `principalId: "owner"` with every permission (`server/session-admission-auth.ts`). |
| Does the daemon have user accounts? | No. `docs/permissions.md` describes principals, credentials and pairing invitations as a model, but the code implements only: a shared bcrypt daemon password, a local credential file, and Hub service principals. *(no invitation or per-device credential code found)* |
| Are daemon permissions enforced? | Yes, per message type, inbound and outbound (`authorization/operation-permissions.ts`, `Session.handleRequest` at `session.ts:2521`). |
| Are permissions scoped to a project, workspace or agent? | **No.** `docs/permissions.md`: "Permissions are daemon-wide today. Future grants may select workspaces or agents." |
| Do plugin RPC handlers know the caller? | **No.** `PluginHandlerContext = { paseo: PaseoApi }` (`plugin/src/server/contracts.ts`). *(probe, static)* |
| Can a plugin hook into admission? | **No.** Admission is a pure function in core (`resolveSessionAdmission`). |
| Do plugins run sandboxed? | **No.** Subprocesses run as the daemon user, and attach with `OWNER_SESSION_ADMISSION` (`websocket-server.ts:1189`). |

## 2. Connection admission

```text
client ──ws /ws──▶ verifyClient (Host + Origin allowlist only; DNS-rebinding guard)
                   └▶ attachAuthenticatedSocket
                        header bearer present? ── bcrypt compare vs daemon password ─▶ OWNER_SESSION_ADMISSION
                        else: wait for `hello` (15 s timeout)
                              └▶ resolveSessionAdmission(hello.auth)
                                   no password configured ───────────▶ owner, all permissions
                                   auth.kind = "localCredential" ────▶ owner (reads PASEO_HOME/local-credential)
                                   auth.kind = "password" ───────────▶ owner (bcrypt, cost 12)
                                   else hello.rejected
```

- `hello.sessionPermissions` lets a client **narrow** its own session to a subset. The client chooses the
  ceiling, so this is attenuation, not a boundary. *(probe: a narrowed session is denied `plugin.list` and
  `project.add`; the same password reconnects unnarrowed.)*
- Session key is `[principalId, clientId]` (`websocket-server.ts:3336`). A hello with a known `clientId`
  re-attaches the existing Session. Every password holder shares one principal, so one client can resume
  another's session if it knows the `clientId`.
- Other admission paths yielding owner: relay (`attachExternalSocket`, then hello password), plugin sockets,
  and the local credential. **Hub** is the only multi-principal path: `hub:<daemonId>:<credFingerprint>` with
  persisted relationship permissions (`hub/relationship-controller.ts`).
- Live revocation exists: `WebSocketServer.updatePrincipalPermissions(principalId, permissions)` swaps the
  permissions of live sessions and closes host links. It is the reusable pattern for "disable a user now".

## 3. Authorization

Nine semantic permissions (`protocol/src/messages.ts` `DAEMON_PERMISSIONS`): `daemon.read`, `daemon.manage`,
`tunnel.manage`, `access.manage`, `workspace.read`, `workspace.write`, `workspace.manage`,
`automation.manage`, `hub.execute`. Agents and terminals deliberately share `workspace.*` because "both can
execute code and mutate the workspace".

- Every inbound and outbound message type has a requirement, enforced by `SessionAuthorization`.
- `plugin.*` management **and** `plugin.rpc.invoke/subscribe` require `daemon.manage`. So a non-operator
  session cannot call plugin RPCs at all *(probe)*. That protects plugin management but also means a
  plugin-hosted login RPC is unreachable by the people who need to log in.
- Not covered by the permission gate: `/mcp/agents` (capability token or password), `/api/files/download`
  (token only), `/api/terminal-activity`, service proxy, `/api/health`, web UI static; outbound binary frames
  (terminal output, file transfer); the `null`-permission host-routing messages. See `02-...` §4.

## 4. What an authenticated session can reach (cross-user leakage inventory)

All verified in code; none has a per-resource check.

| Surface | Finding |
| --- | --- |
| Agent/workspace/project listing | `fetch_agents`, `fetch_workspaces`, `project.list` return **all** records; filters are client-supplied. |
| Agent control by id | ~40 handler sites resolve `agentId` straight from storage/manager. `resolveAgentIdentifier` scans all agents (`session.ts:5956`). |
| Events | Every Session subscribes to all agent events; `project.update`, script status, config, attention and plugin notifications are broadcast to all Sessions (`websocket-server.ts:1096-1175, 3000-3219`). |
| Push notifications | One `push-tokens.json`, no principal on tokens; sent to all tokens. Presence of one session suppresses another's notification. |
| Terminals | `list_terminals`/`subscribe_terminals` with no `cwd`/`workspaceId` = all terminals; `terminalId` handlers have no owner check. Terminal output is a binary frame that skips the outbound check. |
| Files | `file_explorer`, `fs.*`, `file_download_token` take a raw `cwd` + relative `path`; only the path-within-`cwd` is validated, **`cwd` is never checked against registered workspaces** *(probe: an unregistered directory is listable)*. Download tokens are principal-unbound. |
| Agent MCP `/mcp/agents` | One per-daemon-run capability token is injected into every agent's MCP config; `callerAgentId` comes from an unauthenticated query string. Any agent can read, cancel, archive or kill any other agent. |
| Schedules, heartbeats, loops | One `ScheduleService`, no owner field. |
| Directory sync | One daemon-global `DirectorySyncService`; per-user filtered views would corrupt shared sequence numbers. |
| Config/providers | `daemon.read` exposes configuration and provider information. |
| `StoredAgentRecord.owner` | Exists, but its only variant is `{kind:"daemon", daemonId, executionId}` (a Hub execution). It is not a user concept, though the discriminated union is a natural place for `{kind:"user"}`. |
| `hubExecutionAgents` | Stamp-and-index ownership for Hub sessions. Enforced only inside `hub.execution.*` handlers; a Hub session with `hub.execute` still passes the generic gates and can see non-Hub agents. It shows the pattern but is not a general filter. |

## 5. Device pairing and connected hosts

- Pairing (`daemon.get_pairing_offer`, `access.manage`) produces a link that carries the daemon password or a
  relay offer. "Treat this pairing link like a password. Anyone with it can access this daemon"
  (`cli/src/output/pairing.ts`). A pairing link therefore identifies a **device holding the shared secret**,
  not a person. *Association of a device to an authenticated user is not possible today.* The device-to-user
  mapping `docs/permissions.md` describes (credential → principal) is the intended upstream shape and the
  right attachment point (`02-...`, `05-...`).
- Connected hosts (`docs/connected-hosts.md`) intersect forwarded caller grants with the link principal's
  authority; useful precedent for per-principal attenuation, and a reason to keep principal semantics
  identical on both ends of a link.

## 6. Plugin lifecycle and SDK facts

- Manifest `paseo-plugin.json`; server entry `index.server.ts` (subprocess), client entry `index.client.tsx`
  (runs inside every connected app). `server/`, `shared/`, `client/` directories; the compiler rejects other
  code modules in the plugin root and cross-runtime imports.
- Server context: `handle(rpc|subscription)`, `registerSettings`, `addHook`, `registerProvider`,
  `registerUsageSource`, `registerWorktreeManager`, `notifications`. Handler context: `{ paseo }`. A handler
  owns "an IPC-backed daemon session", which is `plugin:<id>` with owner admission.
- Hooks (`public-docs/plugins/hooks.md`): payloads carry no caller identity. `agent.open.before` and
  `terminal.create.before` can add env, **wrap** the launch (`[executable, ...args]`) or throw to refuse.
  Documented wrap gaps: Paseo's host terminal tools, provider probes, and a later open without the plugin.
- Client: screens, sidebar items, settings screens, panels, composer items. A plugin client loads **after** the
  app has connected, so a plugin login screen cannot gate the connection.
- Plugin SDK `@getpaseo/plugin` 0.17.x is Apache-2.0; the manifest declares `requirements.paseo`.
- Plugins are unsandboxed by design (`docs/plugins.md`: "Trust every plugin you add").

## 7. Conventions in your existing plugins

| | meute-fleet | paseo-multi-profile | paseo-etat-major |
| --- | --- | --- | --- |
| State | Settings API only; no data files | **Workspace** profiles (home/work): label `profile:<id>`, env injection via `agent.open.before`; settings-stored | README stub only |
| License | AGPL-3.0 | MIT | MIT |
| Tooling | tsc, eslint, vitest, mutation script | tsc only | none |
| CI | none | none | none |
| Pins | `@getpaseo/plugin` exact, ranges elsewhere | same | n/a |
| Security notes | README "Threat model": unsandboxed, no caller identity, paired device = operator | OVERVIEW: "a view and a label, not access control" | n/a |

`paseo-multi-profile` has no RPCs, no user concept and no integration point, and "profile" there means a
workspace grouping, not core *Agent profiles* (provider/model presets, MCP `list_profiles`). The integration
contract (`08-...`) must disambiguate the two. Licence: this repo uses Apache-2.0 to match upstream and the
SDK (your plugins are inconsistent: AGPL, MIT).
