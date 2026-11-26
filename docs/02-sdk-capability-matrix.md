# 02 — Plugin SDK capability matrix

What can be done **entirely in a plugin**, what needs a **core change**, and what is **impossible without
leaving the single-uid trust model**. Verified against Paseo 0.17.5 / SDK 0.17.4. Evidence is in
`01-current-paseo-auth-architecture.md`; *(probe)* means `probes/blockers.probe.ts` confirms it on a disposable
daemon.

Legend: ✅ plugin-only · 🟡 plugin + small core change · 🔴 core change required (blocker for the MVP) ·
⚫ not achievable by application code at all (needs OS/VM isolation).

## 1. Matrix

| # | Capability | Status | Why / evidence | Smallest fix |
| --- | --- | --- | --- | --- |
| 1 | Store accounts, hash passwords, issue and revoke login tokens, throttle, audit | ✅ | This repo's kernel (`server/kernel`), 74 unit tests. Needs only `node:crypto` and files. | — |
| 2 | **Authenticate a connection** as a user so direct daemon/RPC access cannot bypass login | 🔴 | Admission is core: one `owner` principal for the shared password; no hook. *(probe)* | Pluggable admission provider (`05-…` R1). |
| 3 | Know **who is calling** inside a plugin RPC / hook | 🔴 | `PluginHandlerContext = { paseo }`; hook payloads carry no caller. *(probe, static)* | Pass authenticated principal in handler context (R2). |
| 4 | Let a non-operator call a plugin RPC (e.g. login, "my sessions") | 🔴 | `plugin.rpc.invoke` requires `daemon.manage`. *(probe)* | Per-RPC declared permission, or a dedicated `auth.*` pre-admission message (R1). |
| 5 | Restrict **plugin management** to administrators | ✅ (today) | `plugin.*` already requires `daemon.manage`. *(probe)* | Keep. Developers must never receive `daemon.manage`. |
| 6 | Give a user a *narrower* set of daemon permissions | 🟡 | `hello.sessionPermissions` exists but the **client** sets it. *(probe)* Server-side ceilings per principal exist only for Hub. | Admission returns permissions from the provider (R1). |
| 7 | Revoke a user's live sessions immediately | 🟡 | `updatePrincipalPermissions` does it for a principal id; only reachable from core code. | Expose to the admission provider (R1). Kernel side is done (✅). |
| 8 | **Per-user project / workspace / agent visibility** | 🔴 | Permissions are daemon-wide; every list and event is global. Largest item. | Resource-scoped grants (R3). |
| 9 | Per-user **terminal and file** access | 🔴 | Handlers take raw `cwd`/`path`/`terminalId`; `cwd` not tied to a workspace. *(probe)* | R3 + R4. |
| 10 | Per-user **event streams / notifications / push** | 🔴 | Global broadcasts; push tokens unbound to principals. | R3 (outbound filter), R5 (push). |
| 11 | Per-user **Agent MCP** (`/mcp/agents`) | 🔴 | One capability token for all agents; `callerAgentId` unauthenticated. | Per-agent tokens bound to principal (R6). |
| 12 | Per-user file-download tokens | 🔴 | Token store is principal-unbound. | R4. |
| 13 | Per-user schedules / heartbeats | 🔴 | One service, no owner. | Owner field + filter (R3). Out of MVP; deny `automation.manage` to developers. |
| 14 | Associate **device pairing** with a user | 🔴 | Pairing = shared secret; no per-device credential. | Credential → principal registry (R1), matching `docs/permissions.md`. |
| 15 | Record session ownership at creation | 🟡 | `agent.create.after` hook exists, but without caller identity (#3) the owner cannot be named. Core already stores `owner` on agents. | `{kind:"user"}` owner variant (R3). |
| 16 | Login/admin **UI** | 🟡 | Plugin client can add screens, sidebar items, settings. But the app connects **before** plugins load, so the *login* screen must be part of the connection flow, not a plugin screen. | App connect flow gains a "sign in" step (R1). Admin/account screens: ✅ plugin. |
| 17 | Run a workspace's agents under a **different Unix account / container** | 🟡 | `agent.open.before` and `terminal.create.before` can `wrap` launches and refuse. Binds to the **workspace**, not the caller. Gaps: host terminal tools, provider probes. | Document gaps; per-workspace `unixAccount` mapping in a plugin. |
| 18 | Isolate a user from the daemon operator's files and credentials | ⚫ | Plugins and agents run as the daemon uid. An agent can read `~/.paseo/local-credential`, `config.json`, and this plugin's `users.json`. | Separate Unix accounts / rootless containers / VMs. |
| 19 | Credential brokering (SSH, GitHub, provider keys) | 🟡 | Store **references**; deliver through `agent.open.before` `env`/`mcpServers`/`wrap` per workspace. Never mount `~/.ssh` or the agent socket. | Separate broker component (out of MVP). |
| 20 | External IdP (OIDC, passkeys) | ✅ (design) | `ExternalIdentity` table and `IdentityProvider` seam in the kernel; implement later. | — |
| 21 | Profiles integration | ✅ | Read-only versioned context + deny-by-default evaluator (`08-…`). | — |

## 1b. Status on the `feat/users-admission` core branch

Rows 2, 3, 4(partial), 6, 7 and 14(partial) move from 🔴/🟡 to **done on the branch**: admission provider (R1), caller
identity in plugin handlers (R2), live revoke and narrowing. Row 4 is only partly closed: plugin RPC still requires
`daemon.manage`, so developer self-service lives in the provider's `/api/auth/*` instead. Rows 8–13 (resource
scoping, files/terminals, events, MCP, tokens, schedules) are unchanged: still core work (R3–R7). Details in
`05-core-extension-requirements.md`.

## 2. Reading the matrix

- **Rows 2, 3, 8 are the blockers.** Without admission (2) there is no authenticated user; without caller
  identity (3) plugin code cannot authorize; without resource scoping (8) two authenticated users still see each
  other's everything. The SDK cannot provide any of them.
- A plugin-only deployment can *look* multi-user (accounts, a login screen, filtered lists in the client) while
  enforcing nothing. This repo refuses to ship that: `users.status.get` reports `enforcement: "none"`, the
  daemon mapping returns **zero** permissions when core capabilities are absent
  (`server/kernel/daemon-mapping.ts`), and no account-mutating RPC is registered.
- **Row 18 is independent of every software change.** While plugins, agents and the daemon share a uid,
  application-level separation protects against *mistakes and curiosity*, not against a developer's agent
  that runs `cat` on the operator's files. Do not describe the shared-daemon mode as multi-tenant until row 18
  is addressed per workspace (rows 17/19) and tested.

## 3. Deployment topologies that follow from the matrix

| | **A. Shared daemon, principal-aware** | **B. Daemon per Unix account** |
| --- | --- | --- |
| Core change | Large (R1–R6) | **None** |
| Isolation of users | API-level only until agents are wrapped into per-user accounts/containers | **OS-enforced**: separate uid, `PASEO_HOME`, port, password, credentials |
| Shared projects | Native (grants) | Via Unix groups / explicit shared worktree; no live co-editing in one daemon |
| One app, one login | Yes | App lists one host per user; a front-door chooses the host |
| Revoke a user | Disable account, drop sessions | Stop the user's daemon, rotate its password |
| Where `paseo-users` fits | Plugin + core extension | Directory, provisioning and credential-reference tooling around standard daemons |
| Fits "a two-person household on one host" | Eventually | **Now**, and is the secure baseline for A's agent isolation too |

Recommendation and decision request: `docs/07-roadmap.md` §Decision.
