# 12 — Plan: shared and separate installs, side by side

Status: **built in the planner and the CLI, nothing run on a real host.** Implemented and covered by unit tests (fake runner,
temp directories):

- Config rules and the provider catalog: `tools/ctl/config.ts`, `tools/ctl/providers.ts`
  (`test/ctl/install-config.test.ts`, `test/ctl/providers.test.ts`).
- The planner for a separate person (account, own npm prefix, installs, unit, manual logins, checks), the per-person plan
  filter and the hardening in 4a (`test/ctl/separate-plan.test.ts`, `separate-plan-invariants.test.ts`,
  `separate-review-fixes.test.ts`, `hardening.test.ts`).
- The CLI: `add --separate`, the mode in `list`, `plan.json` carrying `install` and `providers`, and the separate
  `notice-<name>.md` (`test/ctl/separate-cli.test.ts`; see [13](13-cli.md)).
- Migration (section 5): `planMigrate` and `paseo-users migrate <name>` (`test/ctl/migrate-plan.test.ts`,
  `migrate-cli.test.ts`, `migrate-review-fixes.test.ts`, `migrate-review-round2.test.ts`).

**UNVERIFIED on a real host** (nothing has been applied): that the `runuser ... env -i` step shape works, that
`npm install --global --prefix` into the account home works, that the four npm packages install and run for a non-operator
account, that each provider login flow works there, that `systemctl --machine=<acct>@.host --user` reaches the account's user
manager, and that the migration moves a live person cleanly. Section 6 is the way to check them.

Goal: let each person be provisioned in one of two ways, from the same config and tool:

| Mode | Linux user | Paseo + provider CLIs | LLM logins | Provider history | Isolation |
| --- | --- | --- | --- | --- | --- |
| **shared** (exists today, `same-user`) | the operator's | the operator's install | shared | **shared** (measured) | data only |
| **separate** (planner built, unverified) | own account | **own install in that account's home** | own login per provider | separate | OS-enforced |

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
2. **Explicit acknowledgement in config** (done): `acknowledge: ["shared-provider-history"]` on each shared-mode person who
   has a neighbour. Without it, `plan` refuses and names the trade-off. One line, written once, deliberate. A separate
   person is not a neighbour: they share no history with anyone.
3. **Per-person notice** (done): `render` writes `notice-<name>.md`, a short plain-language page to hand to that person: what is
   theirs alone (Paseo sessions, projects, password), what is shared (LLM accounts, provider history, the files on the
   machine), and how to ask for separation.
4. **Runbook** (done) and, later, the plugin's account screen shows the person's mode and the same three lines.

## 3. Design for the separate mode

Opt-in per person. A unix-account person with no `install` field keeps today's behaviour exactly: the host `paseoBinary`.

```jsonc
{ "paseoVersion": "0.17.4",                    // top level, exact x.y.z (optional -prerelease), shared by every separate person
  "people": [
    { "name": "<person>", "isolation": "unix-account", "unixAccount": "<acct>",
      "install": "separate",                   // "shared" is only valid with same-user
      "providers": ["claude", "codex"],        // non-empty, unique, from the catalog
      "port": 6768 } ] }
```

Rules (`tools/ctl/config.ts`, all fail closed with a `ConfigError` that lists every problem):

- `install: "separate"` needs `isolation: "unix-account"`; `install: "shared"` needs `same-user`.
- A separate person needs `providers` (non-empty, no duplicates, each in the catalog) and the top-level `paseoVersion`
  (exact; a range, a tag such as `latest`, build metadata or spaces are refused).
- `providers` on a person who is not separate, and `paseoVersion` with nobody separate, are errors, not ignored.
- A separate account home may not equal, contain or sit inside `userHome`, `homeBase`, the host `paseoBinary` or an
  absolute `environmentPath` entry (see 4a).

The catalog (`tools/ctl/providers.ts`) is npm-only: one npm prefix inside the account home, `<acctHome>/.local/npm`,
binaries in `<prefix>/bin`. Package names checked against the npm registry on 2026-11-27:

| Provider id | npm package | Binary |
| --- | --- | --- |
| (Paseo itself, pinned to `paseoVersion`) | `@getpaseo/cli` | `paseo` |
| `claude` | `@anthropic-ai/claude-code` | `claude` |
| `codex` | `@openai/codex` | `codex` |
| `opencode` | `opencode-ai` | `opencode` |

Provider CLIs are installed unpinned (latest at install time); the planner warns about that. Whether these installs and the
login flows work for a per-account prefix is **UNVERIFIED** on a host.

Plan steps for a separate person, in the order the planner emits them (`tools/ctl/isolation/unix-account.ts`). Every step is
privileged: `apply` runs them as root, and account-level commands drop to the account with
`runuser -u <acct> -- env -i HOME=<acctHome> PATH=/usr/local/bin:/usr/bin:/bin <argv...>`. Commands are argv arrays, never a
shell string.

1. `useradd`, `lock-password`, `account-home` (root creates the account and its 0700 home).
2. `paseo-home`, `config-dir`, `systemd-dir`, `unit-dir`: created by the account with `mkdir -p -m 0700`, not by root.
3. `guard-*`: `test ! -L` on the paths root writes through next.
4. `secret-env` (0600) and `unit` (root writes both before any account code runs). The unit's `PATH` is
   `<acctHome>/.local/npm/bin:/usr/local/bin:/usr/bin:/bin` and its binary is `<acctHome>/.local/npm/bin/paseo`. It never
   contains the operator's `userHome`, `paseoBinary` or `environmentPath`.
5. `local-dir`, `npm-prefix`, `install-paseo` (`npm install --global --prefix <prefix> @getpaseo/cli@<paseoVersion>`),
   then one `install-<provider>` per listed provider.
6. `linger`, `daemon-reload`, `enable` (the account's user manager is reached with `systemctl --machine=<acct>@.host --user`).
7. **Manual, by the person**: `llm-login`, then one `login-<provider>` step each (for example `claude` then `/login`,
   `codex login`). The plan cannot do this and never copies the operator's tokens.
8. Verify: health check, `verify-install` (`<prefix>/bin/paseo --version` as the account), a manual `verify-operator-home`
   (confirm the account cannot read the operator's home; the step does not name the path), `verify-unreadable` checks
   against neighbours, and the manual `verify-app`.

Revocation is the same as for any unix-account person: disable the unit, rotate the password, lock the account, end its
processes. The account home is kept.

## 4. What changes in the tool

All items are done in code and unit tests; none has run on a real host.

- [x] `config.ts`: `install`, `providers`, `paseoVersion`, `acknowledge`; validation rules (section 3; the acknowledgement
  rule is in section 2).
- [x] `isolation/unix-account.ts`: install and provider steps; `PATH` built from the account's own directories; the
  operator's `paseoBinary` is not used for separate installs.
- [x] `providers.ts`: the catalog (npm package, binary, login hint per provider). Adding a provider is one entry, not new
  strategy code.
- [x] `render.ts` and `notice.ts`: `notice-<name>.md`, with a separate variant that names no host, path, address, port,
  account or version.
- [x] Tests for every rule above, plus: a separate person's unit and `PATH` contain nothing under the operator's home, no
  operator credential path appears in a separate person's plan, acknowledgement refusal, and the migration plan (section 5).
- [x] CLI: `add --separate`, mode in `list`, `plan.json` with `install` and `providers`, `migrate` ([13](13-cli.md)).
- [ ] A real-host run (section 6).
- [ ] Resume after a failed step (4a: apply is not resumable).
- [ ] The plugin's account screen showing the person's mode (section 2, item 4).

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
   `guard-old-env-file` (`test -d`, `test -f`: a missing source, or an already migrated person, fails before `useradd`),
   `guard-old-unit-home` and `guard-old-unit-env` (`grep -q -x -F -e Environment=PASEO_HOME=<old home>` and
   `EnvironmentFile=<old env file>` on the old unit: the directory that is moved and the file that is copied must be the
   ones the shared daemon really uses, so a wrong `homeBase` that happens to hold an unrelated `<name>/` and `<name>.env`
   is refused), `guard-old-account` (`test ! -e <account home>`: `useradd` would fail there after the old daemon is stopped;
   it does not check whether the user or group exists elsewhere), and
   `guard-old-hardlinks` (`find <old> ! -type d -links +1 -exec false {} +`: `chown` changes the inode, so a hard link to a
   file outside the home would hand that file to the account). All UNVERIFIED on a real host. A race with a process that is
   still running is not closed; the stop and the pid guard are what keep the old daemon down. `planMigrate` also refuses
   (`ConfigError`), before any step exists, when the old PASEO_HOME or env file equals or contains `userHome`; when `homeBase`
   is `userHome` itself (the source would be an ordinary directory of your home); when `paseoBinary` or an `environmentPath`
   entry (`%h` expanded) lies inside the old PASEO_HOME or env file, since the move and chown would take it from the host; and,
   for a hand-built config, when it breaks any rule `parseConfig` applies (`revalidateResolved`: names, paths, ports, the
   account-home overlaps, version, providers). `migrate` also refuses (exit 2) an `--out`, or a default render directory,
   that is, lies inside, or contains the old PASEO_HOME or env file, also through a symbolic link: the move would take the
   output directory with it, and rendering into a reused directory deletes `<out>/files`. Rendering replaces `plan.json`,
   `apply.sh`, staged files and secret files instead of writing through a symbolic link, and refuses a `secrets/` that is a
   link. A runner that cannot start a command is reported as a failed step. A failure after the old unit was stopped but
   before the move names the unit and the enable command; the old-home guard failing says the opposite (the person is
   probably already migrated, do not re-enable the old unit). All UNVERIFIED on a real host. There is no check that the source looks
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

1. Unit tests for all of section 4: done (`npm test`).
2. A disposable run that does not need root: render and review only (`paseo-users render`, then read `apply.sh`). Not
   recorded as done.
3. A real run on the target host, which needs you for the root steps. Create a test account first (not a person's),
   install, start, log in to one provider, run one agent turn, confirm that account cannot read the operator's home and
   the operator's provider history is not visible, then remove the test account. Only after that, migrate a real person.
   Not done.

## 7. Open questions

Still open:

- Should shared folders for collaboration be part of the plan (a group-owned directory), or stay manual? Nothing is built;
  it stays manual.
- Whether `systemctl --machine=<acct>@.host --user` (what the planner emits) reaches the account's user manager, versus
  `sudo -u` or `machinectl shell`. To be verified on the host before relying on it.
- Whether provider CLIs should be pinned too. The default chosen: they are not pinned (latest at install time) and the
  planner warns about it.

Answered by the code (change them in a later slice if the answer is wrong):

- Which providers: no default. A separate person lists them (`claude`, `codex`, `opencode`); an empty list is refused.
- One account per person, or a shared account: one account per person. A duplicate `unixAccount` is a config error, and
  `add --separate` needs an explicit `--unix-account`, so no account name is guessed.
- Which version: no default and no `latest`. One exact `paseoVersion` is stored for every separate person.
