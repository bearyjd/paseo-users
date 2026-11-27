# 12 — Plan: shared and separate installs, side by side

Status: config validation, the provider catalog and the planner for separate installs are implemented and covered by unit
tests (`test/ctl/install-config.test.ts`, `test/ctl/providers.test.ts`, `test/ctl/separate-plan.test.ts`). Nothing has been
applied on a real host: the npm installs, the `runuser` step shape and the provider logins are **UNVERIFIED**. Migration (§5)
and `notice-<name>.md` are not implemented.

Goal: let each person be provisioned in one of two ways, from the same config and tool:

| Mode | Linux user | Paseo + provider CLIs | LLM logins | Provider history | Isolation |
| --- | --- | --- | --- | --- | --- |
| **shared** (exists today, `same-user`) | the operator's | the operator's install | shared | **shared** (measured) | data only |
| **separate** (to build) | own account | **own install in that account's home** | own login per provider | separate | OS-enforced |

Both stay available; you pick per person. Switching a person from shared to separate later is a supported migration (§5).

## 1. Facts found on the target host (read-only checks)

- Paseo, Claude Code, Codex and OpenCode are all installed under the operator's home: npm prefix `~/.local/npm`, Claude
  in `~/.local/share/claude`, OpenCode in `~/.opencode`. `~/.local` is mode 700 and the home is 750. Another Linux user
  **cannot execute any of them**. Only `node`, `git` and `podman` are system-wide.
- There is one human account today. `sudo` needs interactive authentication, so any root step must be run by you, not
  by an agent.

Consequence: today's `unix-account` strategy is incomplete. It points every daemon at one shared `paseoBinary`, which
another account cannot run here. A separate person needs their own install.

## 2. Handling the shared-history trade-off (shared mode)

You accepted that a shared-mode person can see and import the operator's provider history. Make that visible wherever
someone sets it up or uses it, without blocking it:

1. **Planner warning** (done): printed whenever a shared-mode daemon sits next to another daemon.
2. **Explicit acknowledgement in config**: `acknowledge: ["shared-provider-history"]` on each shared-mode person who
   has a neighbour. Without it, `plan` refuses and names the trade-off. One line, written once, deliberate.
3. **Per-person notice**: `render` writes `notice-<name>.md`, a short plain-language page to hand to that person: what is
   theirs alone (Paseo sessions, projects, password), what is shared (LLM accounts, provider history, the files on the
   machine), and how to ask for separation.
4. **Runbook** (done) and, later, the plugin's account screen shows the person's mode and the same three lines.

## 3. Design for the separate mode

A new per-person field selects the install, validated against the isolation strategy:

```jsonc
{ "name": "<person>", "isolation": "unix-account", "unixAccount": "<acct>",
  "install": "separate",                       // "shared" is only valid with same-user
  "providers": ["claude", "codex"],            // which provider CLIs to install for this account
  "port": 6768 }
```

Host-level config adds `paseoVersion` (pin the person's Paseo to the operator's version, today 0.17.4, so the app and
both daemons speak the same protocol).

Plan steps for a separate person, in order (root steps are flagged and run by you; user steps run as that account via
`sudo -u <acct> -H` or `machinectl shell`, which is still unverified):

1. root: create the account (locked password, own group, home 0700), enable linger.
2. account: set an npm prefix in its home and `npm install -g @getpaseo/cli@<paseoVersion>`; record the binary path.
3. account: install each listed provider CLI using that provider's own installer into the account's home.
4. account: create `PASEO_HOME` (0700) and the 0600 password file; install the systemd user unit with a `PATH` built from
   the account's own install directories (never the operator's).
5. account: start the unit; health check.
6. **manual, by the person**: log in to each provider (`claude` then `/login`, `codex login`, …) in a shell as that account.
   The plan cannot do this, and must not copy the operator's tokens.

Revocation stays the same as today: stop and disable the unit, rotate the password, and for separate installs also lock
the account.

## 4. What changes in the tool

- `config.ts`: `install`, `providers`, `paseoVersion`, `acknowledge`; validation rules (§2.2; `separate` requires
  `unix-account`; `shared` requires `same-user`; providers from a known list; version must be exact).
- `isolation/unix-account.ts`: add install and provider steps; build `PATH` from the account's directories; stop using the
  operator's `paseoBinary` for separate installs.
- A small `providers` catalog module (install command, binary location, login hint per provider), so adding a provider
  is one entry, not new strategy code.
- `render.ts`: `notice-<name>.md`.
- Tests: every rule above, plus "a separate person's unit and PATH contain nothing under the operator's home", "no
  operator credential path appears in a separate person's plan", acknowledgement refusal, and a migration plan (§5).

Estimated size: one focused slice, similar to the original planner.

## 4a. Implemented behaviour and known limits (all UNVERIFIED on a real host)

Verified by unit tests only (`test/ctl/review-fixes.test.ts`, `test/ctl/separate-plan*.test.ts`); no command was run on a host.

- Account-level commands run as `runuser -u <acct> -- env -i HOME=<acctHome> PATH=/usr/local/bin:/usr/bin:/bin <argv>`.
  `env -i` drops every other variable of the apply process (npm tokens, API keys, `NPM_CONFIG_*`, `NODE_OPTIONS`,
  `LD_PRELOAD`), so they do not reach npm or its lifecycle scripts.
- `plan <name>` and `apply <name>` for a separate person include only that person's own steps. The `same-user.*`
  prerequisites and any check naming a same-user neighbour's `PASEO_HOME` under the operator's home are left out; the hand-run
  `verify-operator-home` check covers that home. The only step that names `userHome` is that check.
- `apply` compares each staged file with the plan before it runs any command, so an edit to a staged unit after render is
  refused (render again and review).
- A separate account home may not equal, contain or sit inside `userHome`, `homeBase`, the host `paseoBinary` or an absolute
  `environmentPath` entry. The planner cannot see the disk, so it cannot tell whether a directory already exists: choose an
  account name and `unixAccountHomeBase` that are new.
- **Not resumable.** `apply` stops at the first failing step and has no per-step resume. The first step, `useradd`, fails once
  the account exists, so after a failed install step (registry timeout, EACCES) a second `apply <name>` stops at `useradd`.
  Run the remaining steps by hand from `apply.sh` (or remove the half-made account and start again). This is true for every
  unix-account person, not only separate installs. A resume option is not built.
- **Symlinks in account-owned paths.** Root creates `.local`, `.local/npm`, `.config` and the other account directories with
  `install -d -o <acct>`. The account's own agents can replace one of them with a symlink after the first apply, and a later
  root apply would follow it (chown and chmod the target, or create a directory in it). Before re-applying, check that these
  paths are real directories (`test ! -L`). Not mitigated in code; household-level trust only (`04-threat-model.md` T20).

## 5. Migration: moving a person from shared to separate

`planMigrate(config, name)` would produce: stop and disable the shared unit; create the account and install (§3); move
the person's `PASEO_HOME` into the account and `chown` it (keeps their Paseo sessions, projects, server identity and
password); install and start the new unit **on the same port**, so their saved connection keeps working; leave the
operator's provider history behind. Their provider logins start fresh.

## 6. How we would verify it

1. Unit tests for all of §4.
2. A disposable run that does not need root: render and review only.
3. A real run on the target host, which needs you for the root steps. Create a test account first (not a person's),
   install, start, log in to one provider, run one agent turn, confirm that account cannot read the operator's home and
   the operator's provider history is not visible, then remove the test account. Only after that, migrate a real person.

## 7. Open questions

- Which providers the separate person needs (Claude only, or Codex and OpenCode too)?
- One account per person, or one shared "family" account for everyone who is not the operator?
- Should shared folders for collaboration be part of the plan (a group-owned directory), or stay manual?
- How the account's user manager is reached for user-level steps: `sudo -u`, `machinectl shell`, or
  `systemctl --machine=<acct>@.host --user`. To be verified on the host before relying on it.
