# 06 — Data model

Source of truth: `shared/model.ts` (Zod). Persistence follows Paseo's convention (`docs/data-model.md` upstream):
file-based JSON, Zod-validated on load, atomic writes. Default location (when wired into a daemon):
`<PASEO_HOME>/plugin-data/paseo-users/` (directory 0700, files 0600). The path is injected, never hardcoded.

```text
users.json        one document, schemaVersion 1   (see below)
audit.jsonl       append-only security log
bootstrap-token   exists only before first-run; deleted on success
users.json.vN.bak written before each migration; used for rollback
```

## Entities (`users.json`)

| Entity | Key fields | Notes |
| --- | --- | --- |
| `Role` | `id`, `name`, `builtin`, `permissions[]` | `administrator`, `developer` seeded. Permissions are `UsersPermission` (not Paseo daemon permissions). |
| `User` | `id`, `username` (unique, lower-case), `displayName`, `roleIds[]`, `status`, `passwordHash` (PHC scrypt, nullable), `mustChangePassword`, `unixAccount?` | `unixAccount` is a *reference* for an execution layer. Null `passwordHash` = account that can only use an external identity. |
| `LoginSession` | `id`, `userId`, `tokenHash` (SHA-256), `deviceId?`, `deviceLabel?`, idle/absolute expiry, `revokedAt/Reason`, `remoteAddress?` | Raw token never stored. `deviceId` is the hook for associating a Paseo-paired device with a user (R1). |
| `Invitation` | `kind: invite\|reset`, `tokenHash`, `roleIds`, `targetUserId?`, `createdBy`, `expiresAt`, `usedAt`, `revokedAt` | Single-use. |
| `ExternalIdentity` | `userId`, `provider`, `subject` | Reserved for OIDC/passkeys; unused in MVP. |
| `Project` | `id`, `paseoRef`, `name`, `ownerId?`, `members[{userId, access: read\|write}]` | `paseoRef` = how Paseo identifies the project (project key / workspace id). `ownerId: null` = administrator-owned. |
| `SessionOwnership` | `paseoAgentId`, `ownerId`, `projectId?` | Who a coding session belongs to. Mirrors the future `{kind:"user"}` agent owner in core (R3). |
| `Allowance` | `userId`, `kind: profile\|sandbox\|provider\|credential\|host`, `ref` | Admin-managed allow-list. `ref` is an id or credential **reference**, never a secret. |
| `AuditEvent` | `at`, `type`, `actorId?`, `targetId?`, `detail{}` | No secrets. |

### Resources considered, and where they live

| Resource (brief §6) | Representation |
| --- | --- |
| Projects and repositories | `Project` (+ Paseo's own project/workspace registry) |
| Coding sessions, histories | `SessionOwnership` → Paseo agent id; history stays in Paseo storage, filtered by ownership |
| Terminals, worktrees | Not stored here. Authorized through their workspace (R3); terminals inherit the workspace's project |
| Agent profiles / preferences | Profiles plugin; paseo-users stores only the allowance to *use* a profile id |
| Authorized AI providers | `Allowance(provider)` |
| Credential references | `Allowance(credential)` |
| Notifications | Paseo push tokens (R5); not modeled here |
| Connected devices | `LoginSession.deviceId/deviceLabel` (+ Paseo credential registry when R1 lands) |

## Invariants (enforced by code and tests)

- At least one active user holds `users.manage`.
- Usernames unique; project `paseoRef` unique; session id unique.
- A user never appears as both owner and member of the same project.
- Deleting a user removes their sessions, allowances, external identities and ownership records, strips them from
  project memberships, and reassigns their projects to administrator ownership.
- A store file whose `schemaVersion` is newer than the build is refused; an invalid file is refused, never reset.

## Migration and rollback

`server/kernel/migrations.ts` holds pure steps `n → n+1` on raw JSON. `openJsonStore`: back up
`users.json.v<n>.bak` (0600) → run steps → validate → atomic rename; any failure restores the original bytes.
`rollbackToBackup` restores the pre-migration file for an operator downgrade. Adding a permission must not widen
existing roles silently (matches upstream's rule): new permissions are added to `administrator` by a migration and
to no other role.

### Migrating an existing single-user deployment

No migration of Paseo state is needed: enabling `users` mode creates an empty store and a bootstrap token. The
existing daemon password/local credential keep working on the local CLI. Disabling the feature leaves
`users.json` inert on disk. (Production migration steps require explicit approval — not performed.)
