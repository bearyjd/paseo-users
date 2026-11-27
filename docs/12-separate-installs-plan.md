# 12 — Plan: shared and separate installs, side by side

Status: config validation, the provider catalog and the planner for separate installs are implemented and covered by unit
tests (`test/ctl/install-config.test.ts`, `test/ctl/providers.test.ts`, `test/ctl/separate-plan.test.ts`). Nothing has been
applied on a real host: the npm installs, the `runuser` step shape and the provider logins are **UNVERIFIED**. The CLI surface
(`add --separate`, `list`/`plan` mode, `plan.json` carrying `install` and `providers`, and the separate `notice-<name>.md`) is
implemented and covered by `test/ctl/separate-cli.test.ts`. Migration (§5) is implemented as `planMigrate` and `paseo-users migrate <name>`, covered by `test/ctl/migrate-plan.test.ts` and `test/ctl/migrate-cli.test.ts`; also UNVERIFIED on a real host.

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
  prerequisites and any check naming a same-user neighbour's `PASEO_HOME` that is under `userHome`, under the host `paseoBinary`
  or under an absolute `environmentPath` entry are left out. A separate person's plan names none of those values anywhere.
  `verify-operator-home` is a MANUAL verify step: it says to confirm the account cannot read the operator's home and does not
  name the path (the person looks it up as `userHome` in the config). Checks that name a visible neighbour or another account run
  through the same scrubbed `runuser ... env -i` wrapper, not `sudo`.
- `apply` compares each staged file with the plan before it runs any command, so an edit to a staged unit after render is
  refused (render again and review).
- A separate account home may not equal, contain or sit inside `userHome`, `homeBase`, the host `paseoBinary` or an absolute
  `environmentPath` entry. The planner cannot see the disk, so it cannot tell whether a directory already exists: choose an
  account name and `unixAccountHomeBase` that are new. These checks apply to separate people only; a unix-account person with no
  `install` field is not checked (it keeps today's behaviour). `.` and `..` segments in `environmentPath` are refused only while
  a person is separate, so the overlap check cannot be dodged.
- **Not resumable.** `apply` stops at the first failing step and has no per-step resume. The first step, `useradd`, fails once
  the account exists, so after a failed install step (registry timeout, EACCES) a second `apply <name>` stops at `useradd`.
  Run the remaining steps by hand from `apply.sh` (or remove the half-made account and start again). This is true for every
  unix-account person, not only separate installs. A resume option is not built.
- **Symlinks in account-owned paths.** For a separate install the account creates its own directories (`paseo-home`,
  `.config`, `.config/systemd`, the unit directory, `.local`, `.local/npm`) with `runuser ... mkdir -p -m 0700`, so root never
  chowns or chmods a path the account controls. Root still writes two files into the account home (`secret-env`, `unit`), and
  those are ordered before every account-run installer, so on a first apply no account code (npm lifecycle scripts included) has
  run when root writes. Each is preceded by `guard-*` steps (`test ! -L` on `.config`, `.config/systemd`, the unit directory and
  the two files). On a hand-run re-apply, after the account has been running, the guards refuse a symlink that was planted since.
  Not closed: a guard cannot beat a race with a running account process, and root `install` is not symlink-safe, so this
  stays a household-level trust assumption (`04-threat-model.md` T20). The account home itself is still created by root under
  `unixAccountHomeBase`, which must be root-owned. A person without `install` keeps the old root-created `install -d -o`
  directories and the same hazard. Modelled with a fake runner in `test/ctl/hardening.test.ts`; UNVERIFIED on a real host.

## 5. Migration: moving a person from shared to separate

`planMigrate(config, name)` and `paseo-users migrate <name>`. The config describes the **target**: the person is now
`unix-account` + `install: separate`, on the same port. The source is their same-user layout (home `<homeBase>/<name>`, env
file `<homeBase>/<name>.env`, unit `paseo-<name>.service`). It refuses (exit 2) for anyone who is not separate. Steps, in order:

1. `<name>.stop-shared` (unprivileged): `systemctl --user disable --now paseo-<name>.service`.
2. `<name>.guard-old-daemon-stopped` (the FIRST privileged step): `test ! -e <old PASEO_HOME>/paseo.pid`. `apply` runs the
   unprivileged and the privileged steps in separate invocations, in either order, and stops at the first failure. So the
   guard, not the order you run them in, is what keeps `mv` from running under a live daemon: a failed guard stops the root
   phase before the account, the move and the copy. That the daemon writes this file while it runs is seen in
   `probes/daemon-harness.ts`; that it removes it on a clean stop is **UNVERIFIED**. A stale file after a crash blocks the
   migration until you have checked that no daemon runs and removed it (fail closed).
   Right after it come root preflight guards on the old layout, all before the account exists, so a bad source fails before
   the host changes (apply is not resumable): `<name>.guard-old-parents` (`find <every directory above the old home, not />
   -maxdepth 0 -type l -exec false {} +`: a symbolic link in a parent directory, for example a `homeBase` that is a link to
   `/home`, would make `mv` and `chown` follow it while the checks on the last component still pass; set `homeBase` to the
   real path), `guard-old-port` (`grep -q -x -F -e Environment=PASEO_LISTEN=<listenAddress>:<port> -- <old unit file>`: the
   person keeps the SAME port, so the port in your config must be the one the old unit listens on now, or every saved
   connection breaks), `<name>.guard-old-unit-disabled` (`test ! -L` on the unit's
   `default.target.wants` link in your user manager's directory, so an enabled unit that is starting or restarting, or one
   that would start a second daemon at the next login, blocks the root phase), `guard-old-home-link` and `guard-old-env-link`
   (`test ! -L`: root must not follow a link planted by that person's same-user agents), `guard-old-home-dir` and
   `guard-old-env-file` (`test -d`, `test -f`: a wrong `homeBase` or an already migrated person fails before `useradd`), and
   `guard-old-hardlinks` (`find <old> ! -type d -links +1 -exec false {} +`: `chown` changes the inode, so a hard link to a
   file outside the home would hand that file to the account). All UNVERIFIED on a real host. A race with a process that is
   still running is not closed; the stop and the pid guard are what keep the old daemon down. `planMigrate` also refuses
   (`ConfigError`), before any step exists, when the old PASEO_HOME or env file equals or contains `userHome`; when `homeBase`
   is `userHome` itself (the source would be an ordinary directory of your home); when `paseoBinary` or an `environmentPath`
   entry (`%h` expanded) lies inside the old PASEO_HOME or env file, since the move and chown would take it from the host; and,
   for a hand-built config, when `paseoVersion` is missing or not exact, or the providers are empty or unknown. `migrate`
   also refuses (exit 2) an `--out`, or a default render directory, that is or lies inside the old PASEO_HOME or env file,
   also through a symbolic link: the move would take the output directory with it. There is no check that the source looks
   like a PASEO_HOME (no marker file is known); the existing-directory and pid guards are what is checked.
3. The slice 2 account and install steps, without a fresh `PASEO_HOME` (an `mv` into an existing directory would nest the
   old one) and without a rendered password.
4. `<name>.move-paseo-home`: `mv -T <old> <new>` (fails instead of nesting), then `<name>.chown-paseo-home`:
   `chown -R -h <acct>:<acct> <new>` (does not follow symlinks). Both come right after the account home exists and before any
   account code runs.
5. `<name>.carry-secret-env`: `install -m 0600 -o <acct> -g <acct> <old env> <new env>`, after the symlink guard for the
   destination. The existing password keeps working, so their saved connection does too. Nothing is rotated or rendered, and
   the old file is left for you to delete.
6. The new unit is installed and started on the same port; `<name>.migrate-note` (manual): provider logins start fresh and
   your provider history stays behind. Nothing is copied.

The old paths appear only in the stop, guard, move, copy and note steps; the new unit and every account-level command name
nothing of the operator's. The `.paseo-home` mode is whatever the old directory had. Not resumable, like every unix-account apply.
The installs are network steps that come after the irreversible move, and no registry reachability preflight exists (UNVERIFIED
how one would run as root with a scrubbed environment). If an install step fails after the move, the data is already in the
new account and the shared daemon is off: apply prints the failed step, that the move already happened, and the ids of the
steps after it. Fix the cause and run those steps by hand from `apply.sh`; running `migrate` again stops at
`guard-old-home-dir`.

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
