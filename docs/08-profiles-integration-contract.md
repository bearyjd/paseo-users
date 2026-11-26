# 08 — Profiles integration contract (v1)

Source of truth: `shared/profiles-contract.ts` (Zod, `PROFILES_CONTRACT_VERSION = 1`).

## Which "profile"?

Two different things share the name:

| | Core **Agent profile** | `paseo-multi-profile` ("Profiles" plugin, your repo) |
| --- | --- | --- |
| Is | Named provider/model/mode/thinking preset; `list_profiles` MCP tool | **Workspace** grouping (home/work): label `profile:<id>` + env injected by `agent.open.before` |
| Stored | daemon config | plugin settings (`profiles`, `active`) |
| Authority | none | none — OVERVIEW: "a view and a label, not access control" |

Per your brief, "Profiles" can request *agents, models, providers, tools and development settings*; the plugin as it
exists today only requests **environment variables per workspace**. The contract is deliberately small enough to
serve both: it governs *what a profile may ask for*, whatever the profile contains.

## Rule

> A profile is a **request**. paseo-users decides. Selecting, creating or editing a profile never changes what the
> user is authorized to do.

## Direction and coupling

```text
 Profiles plugin ──reads──▶ users.context.get (v1)      paseo-users never imports Profiles
 Profiles plugin ──asks───▶ users.profile.evaluate (v1)  Profiles works unchanged if the plugin is absent
```

- **Absent paseo-users**: Profiles runs exactly as today (single user). It must treat "no context" as
  single-user mode, not as denial.
- **Absent Profiles**: paseo-users never calls it. Allowances referencing profile ids are inert.
- **No cycle**: only Profiles → paseo-users, via plugin RPC, and only when the RPC exists.

## `UsersContextV1` (read)

```ts
{
  contractVersion: 1,
  enforcement: "none" | "enforced",         // "none" ⇒ NOT a security boundary; treat as single-user
  user: { id, username, displayName, roleIds } | null,
  capabilities: UsersPermission[],           // what this user may do inside paseo-users
  permitted: {
    profiles: string[],                      // admin-managed + user-owned profile ids
    providers: string[],                     // AI providers ("claude", "codex", …)
    sandboxes: string[],                     // "native" | "podman:<name>" | "vm:<name>"
    credentialRefs: string[],                // opaque references, never secret values
    hosts: string[],
  }
}
```

`buildUsersContext` returns the empty, `enforcement: "none"` context whenever the daemon cannot enforce — even for a
logged-in user — so a Profiles UI cannot present an unenforced list as a guarantee. The context contains only the
**caller's own** allowances.

## `evaluateProfileRequest(ctx, request)` (decide)

`request = { providers[], sandbox|null, credentialRefs[], profileId|null }` → `{ allowed, granted, denied[] }`.
Each requested item is kept only if present in `ctx.permitted`; everything else is denied by default and listed.
Tested: a greedy profile receives only the intersection; an unenforced context vouches for nothing.

## Where it is evaluated

- **At launch** (`agent.open.before` in the Profiles plugin → call evaluate, drop what is denied or fail the open),
  not only in the UI. UI hiding is cosmetic.
- Ownership of who the *caller* is requires **R2** (caller identity in plugin RPC context). Until then the RPCs
  are not registered (status RPC only), which is why the contract currently exists as a library plus tests.

## Versioning

`contractVersion` increments only on breaking change. Additive optional fields are allowed within v1. A consumer
must ignore unknown fields and refuse a higher `contractVersion` it does not understand.

## Upstream change this needs

R2 (caller in handler context) for the RPC form. Without it, the Profiles plugin can still import
`shared/profiles-contract.ts` types and run `evaluateProfileRequest` against a context obtained another way.
