# 13 — The `paseo-users` command

`paseo-users` keeps its own config and drives the planner from [11](11-daemon-per-person-runbook.md). It plans and
renders by default. Only `apply`, `revoke --apply` and `migrate --apply` change the host, and only with two explicit flags.

Status: the code paths below are covered by unit tests (`test/ctl/`, fake runner, temp directories, injected
environment). **Nothing here has been run against a real host.** Real-host behaviour is UNVERIFIED unless a line says
otherwise.

## Quick start

```bash
npm run ctl:build && npm link          # builds dist/tools and puts `paseo-users` on your PATH
paseo-users init --listen <addr>       # creates the config; finds paseo on PATH and your home by itself
paseo-users add ann --shared
paseo-users add bob --shared --acknowledge-shared-history
paseo-users add cy --separate --unix-account cy --providers claude,codex --paseo-version 0.17.4   # own account and installs
paseo-users plan                       # or: plan ann
paseo-users render                     # writes the plan, units, secrets and notice pages; read apply.sh
paseo-users apply ann --yes --i-understand-this-changes-the-host
```

`npm link` is the `ctl:link` step: it uses the `bin` entry in `package.json` (`dist/tools/ctl/bin.js`). `ctl:build`
marks that file executable and keeps its `#!/usr/bin/env node` line. Without linking you can run
`node dist/tools/ctl/bin.js <command>`.

`init` fills in `paseoBinary` (first `paseo` on `PATH`), `userHome` (`HOME`) and `environmentPath` (the
`Environment=PATH=` line of `~/.config/systemd/user/paseo.service`, if that file exists). It only reads. It never
reads credentials. You must give `--listen`. Check the stored values before you apply.

## Adopt an existing config

If you already provisioned people from a hand-written JSON file:

```bash
paseo-users init --from config.json
```

The file is validated with the same parser, then stored as it is. The host is not touched. The shared-history rule
below applies: add `"acknowledge": ["shared-provider-history"]` to each same-user person who has a neighbour.

## Commands

A value flag may be given once. A repeated flag (for example two `--providers`) is refused with exit 2; only `init --existing` may repeat. Apply runs commands that act as an account (`runuser ...`) from `/`, never from the render directory, and checks that every staged secret of the selected steps exists before it runs the first command.

| Command | What it does | Changes the host |
| --- | --- | --- |
| `init [--from f] [--listen a] [--port n] [--existing name:port]... [--paseo-binary p] [--path P] [--web-ui] [--force]` | Create the config. Refuses to overwrite without `--force`. | No |
| `add <name> --shared [--port n] [--acknowledge-shared-history]` | Add a same-user person. | No |
| `add <name> --separate --unix-account <acct> --providers <id,id> [--paseo-version x.y.z] [--port n]` | Add a person with their own computer account and own installs ([12](12-separate-installs-plan.md)). Nothing defaults: account, providers and an exact version are required (the version may be left out once one is stored; a different one is refused). The result is validated before anything is written; a refusal exits 2 and leaves the config as it was. Providers: `claude`, `codex`, `opencode`. The person logs in to each provider by hand. `--shared` and `--separate` exclude each other and one is required; `--unix-account`, `--providers` and `--paseo-version` are refused with `--shared`, and `--acknowledge-shared-history` with `--separate` (all exit 2). A separate person is not a neighbour, so no acknowledgement is needed for them. **UNVERIFIED on a real host.** | No |
| `remove <name>` | Remove from the config only. Run `revoke` first if they were ever applied. Also deletes that name's staged password files (`secrets/<name>.*`) in the default render directory, so a later person with the same name gets a new password; delete them yourself in any `--out` directory you rendered into. `add` does the same for its name. Only the default config does this: with another `--config` file the default render directory is left alone. `init --force` does it for every name that is gone from the replaced config or is now a different kind of person (another account or mode). Removing someone writes the auto-assigned port of the people after them into the config, so their ports do not move. `add` refuses a `--port` that would move an earlier person's port (exit 2, config unchanged). | No |
| `list [--json]` | People, mode (`shared`, `separate`, or `unix-account` for an account that uses the host binary), port and state. State is `systemctl --user is-active paseo-<name>.service`, asked only for `shared` people (their daemon runs in your user manager). Every unix-account person shows `unknown`, because their daemon is in another account's user manager, as does anything the command cannot tell. | No (read-only) |
| `plan [name] [--json]` | Show the plan. With a name: that person's steps plus, for a shared person, the `same-user.` prerequisites, still validated against everyone. A separate person's plan has only their own steps and names none of your home, host `paseoBinary` or `environmentPath`. `--json` carries `install` and `providers` for a separate person. | No |
| `render [--out d] [--rotate name\|all]` | Write the plan, `apply.sh`, units, secrets and `notice-<name>.md` (a separate person gets the separate page). | No |
| `revoke-plan <name> [--out d] [--json]` | Show (and optionally render) the revoke plan. | No |
| `revoke <name> [--out d] [--apply --yes --i-understand-this-changes-the-host]` | Render the revoke plan into `revoke-<name>`; apply only with the flags. | Only with `--apply` and both flags |
| `migrate <name> [--out d] [--apply --yes --i-understand-this-changes-the-host]` | Move a person from the shared install to their own account ([12](12-separate-installs-plan.md) section 5). The stored config must already describe them as `unix-account` + `install: separate` on the port they use now, or it refuses (exit 2). `add` refuses a name that exists, so change their entry in the config file (`isolation`, `unixAccount`, `install`, `providers`, `port`, and a top-level `paseoVersion`); `remove` then `add --separate --port <their port>` should also work (not exercised by a test). Renders the plan into `migrate-<name>`, with no new password and no `secrets/`; applies only with the flags. Run apply twice: as your normal user (stops the shared unit), then as root. The first root step is a guard that fails while the old daemon may still run, so the move cannot happen under a live daemon whichever phase you run first. It also refuses an `--out` (or default directory) inside the old PASEO_HOME or env file, and its root preflight checks the old unit still listens on the configured port. If a step fails after the move, it says so and lists the steps still to run by hand from `apply.sh`. **UNVERIFIED on a real host.** | Only with `--apply` and both flags |
| `password <name> [--stdin]` | New random password, or one line from stdin as a chosen passphrase. Updates the rendered secrets only and prints the manual steps. | No |
| `apply <name> --yes --i-understand-this-changes-the-host [--out d]` | Apply only that person's steps. | Yes |
| `help`, `--help`, `--version` | | No |

`--config <file>` works on every command.

The older form still works exactly as before: `plan|render|revoke-plan|apply <config.json> ...` (the first argument is a
file name; a person name never contains `.` or `/`, so the two cannot be confused). `render <config.json>` now also
writes the notice pages. A separate person's page says: own computer account with a private home, own installs, own provider logins for the listed providers, own history. It makes no promise about the owner's files (that check is by hand, after setup; UNVERIFIED on a real host). It names no host, path, address, port, account or version.

`apply <config.json>` applies the whole plan and takes no person name: a trailing name is refused (exit 2) instead of being ignored. To apply one person, use the stored config and `apply <name>`.

## Where files live

| What | Where | Mode |
| --- | --- | --- |
| Config | `$XDG_CONFIG_HOME/paseo-users/config.json` (default `~/.config/paseo-users/config.json`) | dir 0700, file 0600 |
| Rendered plan and secrets | `$XDG_STATE_HOME/paseo-users/render` (default `~/.local/state/paseo-users/render`) | dir 0700, `secrets/` 0700, files 0600 |
| Revoke plans | `$XDG_STATE_HOME/paseo-users/revoke-<name>` | same |
| Migration plans | `$XDG_STATE_HOME/paseo-users/migrate-<name>` | same (no `secrets/`) |

The config is the same JSON as in the runbook (`RawConfig`). A fresh `init` stores `"people": []` until the first `add`;
the other commands say so and stop until a person exists. The config holds no passwords.

## Shared-history acknowledgement

A same-user person who has a neighbour (another person who is not a separate install, or any `existingDaemons` entry) must list
`"shared-provider-history"` in `acknowledge`, or validation fails. Reason: same-user people share the Linux user's
provider session history and project directories. `add --acknowledge-shared-history` writes it. It also records it for
existing same-user people who gain their first neighbour from this `add`, and says so. A separate person has their own Linux user and shares no history with anyone, so they are not a neighbour: `add <name> --separate` works next to a lone shared person without any acknowledgement. Unknown values are errors.

## Passwords

- `password <name>` rotates to a new random password.
- `password <name> --stdin` reads ONE line from stdin: `printf '%s\n' "$PASSPHRASE" | paseo-users password ann --stdin`.
  At least 12 characters, not the person's name, printable ASCII without leading or trailing space and without
  `" ' \ $ %` (these are special in systemd environment files). It is never taken from arguments or the environment and
  is never printed. Later `render` runs keep it. Whether the daemon accepts every allowed character is UNVERIFIED.
- Both only rewrite files in the render directory. The daemon keeps the old password until you install the
  `secrets/<name>.env` file and restart it; the command prints those exact steps. For a same-user person it also offers
  `apply <name>`; for a unix-account person it does not, because a second `apply` stops at `useradd`.

The passphrase sits in plaintext in a 0600 file, like generated passwords (see the runbook).

## Apply safety

- `apply` and `revoke --apply` need `--yes` and `--i-understand-this-changes-the-host`, and run only through the process
  runner. Root runs only privileged steps, a normal user only the others.
- `apply <name>` refuses when the render directory has no `plan.json` or it no longer matches the config. It renders the
  current plan and stops, so you read `apply.sh` before running the command again. (It does not apply what you have not seen.)
- Only that person's steps run. For a shared person the same-user prerequisites (`same-user.*`) run too, and re-running them is harmless. A separate person's apply has none of them.
  Applying a person does not restart a daemon that is already running.
- `apply` compares each staged file with the plan before it runs any command, and stops at the first failing step.
  It is not resumable: for any unix-account person a second `apply <name>` stops at `useradd` ([12](12-separate-installs-plan.md) section 4a). After a failed install step, run the rest by hand from `apply.sh`.
- A separate person must log in to each provider by hand, as their own account. `apply` never logs in and copies no credential.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Success |
| 1 | Runtime failure: a step failed during `apply`, or a file-system or process error |
| 2 | Usage error, invalid config, or a refusal (missing flags, stale plan, an invalid `--separate`) |

## Unverified

Everything on a real host, including all of `add --separate`, the separate-install `plan`/`apply` steps (`runuser`, the npm installs, the provider logins, `systemctl --machine`) and `migrate` ([12](12-separate-installs-plan.md)). Also: `init` detection against real units and `PATH`, `list` against a real user manager,
`apply <name>` on a real machine, passphrase characters in a real daemon, `npm link` on your shell. Covered by tests with
fakes: parsing, validation, config and secret file modes, the plan filter, the steps handed to the runner, the refusals.
