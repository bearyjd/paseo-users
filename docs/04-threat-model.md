# 04 — Threat model

## Assets

1. Operator authority over the host (daemon uid, `PASEO_HOME`, `local-credential`, daemon password hash).
2. Each user's source code, session history, terminals and credentials.
3. The account store (`users.json`: password hashes, token hashes) and audit log.
4. Availability of the daemon and of each user's access.

## Actors

| Actor | Capability assumed |
| --- | --- |
| Remote attacker on the tailnet / LAN | Can reach the daemon port; no credentials. |
| Stolen device or session token | Holds one user's valid login token. |
| Malicious or curious **developer** (the son) | Valid developer login; may craft RPCs directly, edit profiles, run agents. |
| Prompt-injected / compromised **agent** | Code running as whatever uid the agent runs under, with that workspace's env. |
| Malicious **plugin** | Runs as the daemon uid with owner admission. Out of scope: installing plugins is an operator trust decision. |
| Operator (administrator) | Trusted; mistakes are in scope. |

## Trust boundaries today vs. required

```text
 client ──▶ [daemon admission] ──▶ [per-message permission gate] ──▶ [resource handlers] ──▶ host (daemon uid)
              one shared secret       daemon-wide, 9 permissions      NO ownership checks      NO uid separation
```

paseo-users adds identity and authorization **above** these; it cannot move the boundaries marked NO. Those
need core work (`05`) and OS isolation (`03` §5). Until then the honest statement is: *accounts exist, nothing is enforced.*

## Threats and mitigations (STRIDE-style)

| ID | Threat | Mitigation in the kernel | Residual / depends on |
| --- | --- | --- | --- |
| T1 | **Bypass the login by connecting straight to the daemon** | None possible in a plugin. | **Blocker** → R1. Interim: daemon bound to loopback/unix socket behind an authenticating gateway, or topology B. |
| T2 | Developer calls admin RPCs directly (account mgmt, plugin install, config) | Kernel checks `Principal` permissions on every mutating method; plugin mgmt requires `daemon.manage`, mapped to administrators only. | Kernel API is not network-exposed yet (by design). |
| T3 | Developer reads/drives another user's sessions, terminals, files | Kernel decisions (`authorizeAgentSession`, project levels) are tested. | **Blocker** → R3/R4: daemon handlers don't call them yet. Same-uid agents can bypass regardless (T9). |
| T4 | Privilege escalation via roles, invitations, resets, delegation | No self role change; actor can't assign/administer beyond own permissions; last-admin guard; reset can't target a more privileged account. | Custom roles added later must be reviewed against the delegation rule. |
| T5 | Profile or preference edit grants more authority | `evaluateProfileRequest` intersection; profiles hold no authority. | Profiles plugin must call it server-side. |
| T6 | Credential stuffing / brute force | Equal-work failures, per-account + per-address throttle, 12-char minimum, scrypt 2^17. | In-memory locks reset on restart; an attacker with network reach can delay a victim up to the lock cap (≤15 min). Prefer tailnet-only exposure. |
| T7 | Username enumeration | One error; dummy hash verification; timing equalized by work. | Invitation redemption reports "username unavailable" (conflict) to an invitee only. |
| T8 | Token theft | 256-bit tokens, only hashes stored, idle+absolute expiry, per-device revoke, revoke-all on password change. | Bearer tokens are bearer tokens: rely on TLS/tailnet; no token binding yet. |
| T9 | **Agent running as the daemon uid reads operator secrets, `users.json`, other users' workspaces; or forges ownership** | None in app code. | **Not achievable in-process** → Unix accounts / rootless containers / VMs per workspace (`03` §5). |
| T10 | Cross-agent control through `/mcp/agents` | None. | **Blocker** → R6. |
| T11 | Store tampering/corruption | Zod validation on load, atomic writes, 0600/0700, corrupt or future-versioned file refuses to start (never silently reset), pre-migration backup + rollback. | A same-uid attacker can edit the file (T9). |
| T12 | Replay of bootstrap token / first-run takeover | Single-use token in a 0600 file; consumed on success; refuses after initialization; constant-time compare. | Anyone who can read the daemon home can already own the daemon. |
| T13 | DoS via concurrent hashing | Semaphore (default 2 concurrent scrypt); throttles run before hashing. | Raise `maxConcurrent` only with memory headroom (≈128 MiB each). |
| T14 | Information disclosure via errors/audit | Audit holds ids and reasons only; tests assert no password/token/hash content. | Review any new audit field. |
| T15 | Revocation lag | Principal resolved per request from store; sessions revoked in the same transaction. | Daemon must close live sockets (R1); cached `Principal` objects are the caller's responsibility. |
| T16 | Downgrade/rollback abuse | Newer-schema stores refused; migrations transactional with backup restore. | Operator running an old build must restore the backup deliberately. |
| T17 | Malicious plugin | Out of scope (operator trust). | Plugins are unsandboxed; document. |
| T19 | **Shared LLM provider tokens readable by any agent** (owner decision to share accounts) | Provider access is an explicit allowance; usage attributed via session ownership and audit. | Tokens are not per-user secrets. Contain with rootless containers mounting only provider token dirs read-only; a hostile developer can still exfiltrate them. Household trust only. |
| T18 | Relay/pairing links as credentials | n/a here. | A pairing link is the shared daemon password; in topology A it must stop granting owner (R1). |

## Non-goals (stated so nobody assumes them)

- Not a defence against a local root user or a compromised operator.
- Not a sandbox, container manager, or VM manager.
- Not multi-tenant isolation for hostile tenants. Household / small-team trust only, until `05` and `03` §5 are met and tested.
- No end-to-end encryption beyond what Paseo's relay and Tailscale already provide.
