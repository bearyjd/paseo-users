# 03 — Proposed security architecture

Six layers, kept separate so that no layer's compromise silently becomes another's.

```text
 ┌ Identity ──────── who is this?                    kernel: users, login sessions, IdentityProvider seam
 ├ Authorization ─── what may they do?               kernel: roles → permissions → resource decisions (deny by default)
 ├ Profile ───────── what do they prefer?            Profiles plugin: a REQUEST, never an entitlement
 ├ Sandbox ───────── where does their code run?      Unix account / rootless Podman / VM, chosen per workspace
 ├ Host ──────────── which machine?                  host allow-list; connected-host links intersect authority
 └ Credential broker what may it reach outside?      references only; short-lived scoped tokens
```

## 1. Rules that hold across layers

1. **Server-side only.** The client may hide things; it is never trusted. Every decision is made in a function that
   takes a server-resolved `Principal` (never a client-supplied user id).
2. **Deny by default.** Permissions are additive allows; unknown session, project, role or action = denied.
   Resources a caller cannot read are reported as *not found*, not *forbidden* (no existence oracle).
3. **A profile can only ask.** `evaluateProfileRequest` intersects a profile's request with the user's
   allowances. Editing or selecting a profile cannot add authority.
4. **Delegation bound.** Nobody grants, assigns or administers authority they do not hold; nobody changes their
   own roles; the last administrator cannot be removed.
5. **Fail closed on missing enforcement.** If the daemon cannot enforce a boundary, paseo-users grants nothing
   rather than something broad (`daemonPermissionsFor`), and reports `enforcement: "none"`.
6. **Secrets are references.** User, profile and allowance records hold credential *references*. Password hashes
   and token hashes are the only secret-derived data stored, and neither is ever returned by an API.
7. **Revocation is immediate.** Disable, delete, role change, password change/reset and admin revoke all end live
   login sessions in the same operation; in the daemon they also drop live sockets (R1).

## 2. Identity

- **Local accounts**: lower-case unique username, display name, role ids, status (`active|disabled`).
- **Passwords**: scrypt (RFC 7914) from `node:crypto`, N=2^17 r=8 p=1, per-hash 128-bit salt, PHC-style
  self-describing string, `needsRehash` for parameter upgrades, bounded concurrency (a login flood cannot
  exhaust memory). Length policy 12–256, no composition rules, rejects trivial values and the username. Argon2id
  is preferred by OWASP but is not in Node 22's `node:crypto`; the `$scrypt$` prefix leaves room to add
  `$argon2id$` and rehash on login. Chosen over `bcryptjs` (already in Paseo) to avoid the 72-byte limit and a
  dependency.
- **Login sessions**: 256-bit random bearer tokens, SHA-256 stored, idle (30 d) and absolute (90 d) expiry,
  per-device label and id, individually revocable. Sliding idle window with throttled writes.
- **Brute force**: per-account and per-address failure throttles with exponential, capped locks; unknown, disabled
  and wrong-password attempts do equal work and return one error. Locks are in memory (a restart clears them;
  documented in the threat model). Admin unlock.
- **Bootstrap**: first administrator is created by presenting a single-use token that only someone who can read
  the daemon's home directory (mode 0600 file) holds. No public registration exists.
- **Onboarding/recovery**: admin-issued single-use expiring invitations and reset tokens (hashed at rest).
- **Future providers**: `ExternalIdentity(userId, provider, subject)` exists in the model. An `IdentityProvider`
  returns an authenticated external subject; the kernel maps it to a user and issues the same login session. No
  provider code ships in the MVP.

## 3. Authorization

- **Roles** are data (`administrator`, `developer` built in) mapping to fine-grained `UsersPermission`s, so new
  roles need no code change. Administrator ⊇ developer.
- **Resource rules** (`server/kernel/authz.ts`): project access = owner | member(read|write) | admin
  (`projects.manage_any`); coding-session access additionally requires *current* project access, so revoking a
  share cuts the sessions made under it; administrators may **read** (audited as `authz.admin_override`) but not
  drive another user's session.
- **Mapping to Paseo permissions** (`daemon-mapping.ts`): administrators map to all nine; developers map to
  `daemon.read`, `workspace.read/write/manage` **only** when the daemon reports resource-scoped grants and a
  redacted `daemon.read`; they never receive `daemon.manage`, `access.manage`, `tunnel.manage`,
  `automation.manage` or `hub.execute`.
- Plugin management stays an operator capability (`daemon.manage` is required today and remains administrator-only).

## 4. Profiles

`08-profiles-integration-contract.md`. paseo-users publishes a read-only per-user context; the Profiles plugin
requests; paseo-users decides. No circular dependency: paseo-users never imports Profiles.

## 5. Sandbox and host

- Authorization **names** execution environments (`sandbox` allowances: `native`, `podman:<name>`, `vm:<name>`);
  it does not manage them. A workspace/project maps to a sandbox and, optionally, a Unix account
  (`User.unixAccount`). The execution layer (a plugin using `agent.open.before`/`terminal.create.before` `wrap`,
  or a sandbox provider) consumes that mapping.
- **Application separation ≠ isolation.** Until a workspace's agents and terminals actually run under a different
  uid or container, a user whose agent can execute code can read the operator's files and this plugin's own
  store. Row 18 of the capability matrix. Required controls for any multi-user claim:
  1. per-user Unix account **or** rootless container per workspace;
  2. `PASEO_HOME`, `users.json`, `local-credential` and `config.json` unreadable to those accounts;
  3. no shared `~/.ssh`, no SSH agent socket, no daemon credential in the agent environment;
  4. host terminal tools and provider probes either wrapped or unavailable to developers (documented wrap gaps);
  5. `/mcp/agents` token bound per agent/principal (R6).
- **Hosts**: `host` allowances restrict which connected hosts a user may route to. Connected-host links already
  intersect caller grants with link authority.
- Initial Alto target (rootless Podman, Tailscale): *native* for operator infrastructure, *rootless Podman* per
  user for protected development, *disposable containers* for experimental agents, *KVM* later for strong
  isolation. The data model carries ids for all four; none are provisioned by this plugin.

## 6. Credential broker

Out of scope for the MVP implementation, specified so nothing blocks it:

- Allowances of kind `credential` hold opaque **references** (`github:alice-ro`, `ssh:alice-deploy`, `mcp:linear`).
- A broker (separate process) resolves a reference to a short-lived, scoped token **for one workspace launch** and
  delivers it through `agent.open.before` env/MCP injection. Raw SSH directories and agent sockets are never
  mounted. Scoped automation identities (GitHub App installation tokens, deploy keys per repo) are the target.
- The kernel stores nothing a broker needs to be secret; compromise of `users.json` yields reference names only.

## 7. Audit

Append-only JSON Lines (mode 0600): logins (success, failure, throttled), logouts, revocations, password
changes/resets, user and role changes, invitations, project sharing, allowances, authorization denials and admin
overrides, migrations. Never records passwords, tokens or hashes (test-enforced).

## 8. Shared LLM accounts (owner decision)

Users share the daemon's provider logins. A `provider` allowance means "this user may use the daemon's configured
provider X"; it is not a credential and nothing per-user is stored. Consequences:

- Per-user cost/usage attribution comes from session ownership and the audit log, not from separate accounts.
  Per-user usage limits would be enforced by paseo-users (counting sessions/turns), not by the provider.
- Provider tokens live where the provider CLIs keep them (e.g. under the daemon user's home). Any agent can read
  them. Sharing them is intended; the risk is that the same readable home also holds the operator's other files. For
  isolation without per-user accounts, run workspaces in **rootless containers that mount only the provider token
  directories read-only** (the Podman route in §5), not separate Unix accounts.
- Other credentials (SSH, GitHub, MCP) remain references with explicit per-user allowances; they are not shared by
  default.
