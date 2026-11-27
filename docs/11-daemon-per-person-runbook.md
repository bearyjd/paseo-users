# 11 — Daemon per person: provisioning runbook

## Status of real-host testing

**One real run so far**, `same-user`, one extra daemon, on Ubuntu 24.04 with a systemd user manager and linger already
on. The rendered plan was applied by hand, step by step, after reading `apply.sh`. Observed:

- The unit installed, passed `systemd-analyze --user verify`, started with `systemctl --user enable --now`, stayed
  active, and listened on its own address and port. `NoNewPrivileges=yes` and `PrivateTmp=yes` did not stop it starting.
- The password from the 0600 `EnvironmentFile` was honoured: the right password was admitted, a wrong one rejected.
- Its project list was empty and independent of the existing daemon, and its local-models directory was under its own
  `PASEO_HOME`, not the existing one.
- Claude, Codex and OpenCode all reported `ready` with their model catalogs, so the daemon sees the provider CLIs when
  `environmentPath` matches the existing unit's `PATH`.
- **A real agent turn worked:** a Claude agent (`claude-haiku-5-5`) created through the second daemon, in an empty temp
  directory, replied correctly using the same login as the existing daemon. So login sharing is proven for Claude.
  Codex and OpenCode turns were not run (they only reported `ready`). The test agent, workspace and project were removed.
- With `webUi: true` the second daemon serves the web UI at `/` (200) while `/api/*` still returns 401 without the password. Without it `/` is a 404, which looks like a failure but is not.
- Restarting only that service (`systemctl --user restart`) brought it back healthy with the same password. This is a service restart, not a reboot.
- **A person signed in from a phone.** Chrome on a phone, over the tailnet, loaded the second daemon's own web UI (`http://<address>:<port>/`) and the owner signed in with that daemon's password using "Direct connection". So a second daemon on its own port works for a real user on a real device. The browser treats the plain-`http` address as not secure; the tailnet itself is encrypted.
- The existing daemon kept running, unchanged.
- Cost: about 1 GB resident while starting (peak 1.7 GB), then roughly 270 MB for the daemon process.

**Still not exercised:** agent turns for Codex and OpenCode (a `ready` status is not proof that logins work; only a
turn is), the native mobile/desktop app with two host entries (only the browser web UI was tried), restart and boot persistence, `unix-account` mode,
and revocation. Treat each as unverified until done. Apply by hand, one person at a time, and check each step.

## What this is

One Paseo daemon per person on one host. Each daemon has its own `PASEO_HOME`, port and password. Each person adds
their own daemon as a host in the app. The tool **plans and renders only**: it writes a plan, unit files, a review-only
`apply.sh` and the passwords into an output directory you choose. It never starts, stops or contacts a daemon.

This is independent of the single-daemon core-extension mode (`07-roadmap.md`, Path A). It needs no core change, no
plugin and no `paseo-users` kernel. Use one or the other for a given person.

Two isolation strategies, chosen per person (`isolation`, default `same-user`):

| | `same-user` (default, first) | `unix-account` (second) |
| --- | --- | --- |
| Linux users | the current user; none created | one new account per person |
| Separated by | data only: `PASEO_HOME`, project registry, agents, password, port | uid, home and file permissions, enforced by the OS |
| LLM logins | shared: provider CLIs use the same home as today (unverified per provider) | **not shared**: each account needs its own login or an API key |
| Needs root | one manual step (linger) | every step |

A strategy is a small module in `tools/ctl/isolation/` behind one interface. A future strategy (for example rootless
Podman) is one new file plus one line in `registry.ts`. The planner does not change.

## Guarantees and non-guarantees

### `same-user`

- Guaranteed by construction: separate `PASEO_HOME` (always `<homeBase>/<name>`, never `~/.paseo`), separate port,
  separate password, separate project registry and agents per daemon.
- **Not OS isolation.** Every daemon and every agent runs as your Linux user. An agent of one daemon can read the files
  of every other daemon, your `~/.ssh`, and the provider credentials. Separation protects against mistakes and
  curiosity, not against a person who tells an agent to read another person's files (`02` row 18, `04`).
- If your existing daemon runs as the same user, same-user agents can read its `~/.paseo`, including its credentials.
  List it under `existingDaemons`; the planner warns.
- Revoking a person stops their daemon and rotates their password. It cannot undo what their agents could already read.

**Shared provider history (measured).** Because all `same-user` daemons use one Linux user's home, provider-native session
history is shared too. A second daemon's `fetch_recent_provider_sessions` returned 20 recent sessions (the default page
size) from the first person's Claude and Codex use, the setup wizard's project suggestions listed the first person's
project directories with "last used" times, and the app shows an **Import session** action. Counts were taken; no session
contents were read. So each person can see, and import into their own daemon, the other's past provider conversations. Paseo's
own sessions, projects and passwords remain separate. If that is not acceptable, use `unix-account`. The planner prints this
as a warning.

### `unix-account`

- Separate uid, home (0700) and `PASEO_HOME` (0700). The OS stops one account reading another's files. The plan includes
  `sudo -u <other> test ! -r <PASEO_HOME>` checks to confirm it. They are not run for you.
- **LLM logins are not shared.** Log each provider CLI in as that account, or put an API key in
  `<account home>/.paseo-provider.env` (the unit reads it if it exists). Which variables each provider reads is
  unverified.
- The paseo binary and the project directories the person works on must be readable and executable by that account.
- Same host, same kernel, same network: this is not a sandbox against kernel bugs or network access between daemons.

## Passwords

`paseo daemon set-password --help` (checked) offers only `--home` and `--json`. It documents no way to read the
password from stdin or a file, so this tool does not use it: that would mean typing it interactively per person.

Instead each daemon reads `PASEO_PASSWORD` from a systemd `EnvironmentFile=`. **This stores the password in plaintext
at rest**, in a file readable only by the daemon's user (0600). The trade-off: anyone who can read that file (root, or
for `same-user` any agent of any daemon) has the password. The unit file, `plan.json` and `apply.sh` never contain it.
It is never put on a command line. `PASEO_PASSWORD` as an environment override is the same mechanism the probes use
(`probes/daemon-harness.ts`), but this repo has not checked that a long-running user unit behaves the same.

Passwords are generated with `crypto.randomBytes` when you render, and written only to `secrets/` (mode 0700):

- `secrets/<name>.password`: the plaintext to hand to the person. Delete it after you have.
- `secrets/<name>.env`: the `EnvironmentFile` that `apply.sh` installs (mode 0600 at the destination).

Re-rendering keeps existing passwords. `--rotate <name>` or `--rotate all` replaces them.

## Config

A JSON file. Everything is input; nothing is defaulted from the machine.

```json
{
  "userHome": "/home/you",
  "listenAddress": "192.0.2.10",
  "basePort": 7100,
  "paseoBinary": "/usr/local/bin/paseo",
  "existingDaemons": [{ "name": "main", "port": 6767 }],
  "people": [
    { "name": "ann" },
    { "name": "bob", "port": 7105 },
    { "name": "cy", "isolation": "unix-account", "unixAccount": "paseo-cy" }
  ]
}
```

Optional: `webUi` (default `false`; sets `PASEO_WEB_UI_ENABLED=true` so each daemon serves the bundled web UI at its own `/`, which the daemon does not do by default. The page is public to anyone who can reach the port; the API still needs the password), `homeBase` (default `<userHome>/.paseo-people`), `unixAccountHomeBase` (default `/home`),
`allowAllInterfaces`, `allowDefaultPort`, `environmentPath`.

**Set `environmentPath` for `same-user`.** A systemd user unit starts with a minimal `PATH`, so a daemon started from a
generated unit may not find provider CLIs (claude, codex, git) and its agents would fail for a reason unrelated to
logins. Copy the `Environment=PATH=...` value from your existing daemon's unit. Entries are absolute directories, or
start with `%h` (systemd's specifier for the user's home); spaces, quotes, empty entries and any other `%` are
rejected. It is ignored for `unix-account` units, because the operator's `PATH` does not belong in another user's
environment.

Rules, enforced at parse time (all errors listed together):

- Names match `^[a-z][a-z0-9_-]{1,31}$` and are unique. Ports are 1024-65535 and unique, including `existingDaemons`.
  People without a `port` get the next free port from `basePort`.
- **Port 6767 is refused** unless `allowDefaultPort: true`. It is Paseo's default port, so it belongs to the existing
  daemon; a second daemon there would fail to bind or be mistaken for it. `existingDaemons` may use it (that is its job).
- **No `PASEO_HOME` is ever `<userHome>/.paseo`** or inside it. That is the existing default daemon's home.
- `0.0.0.0`, `::` and `[::]` are refused unless `allowAllInterfaces: true`.
- `unix-account` needs a POSIX-portable `unixAccount`, not `root`, unique across people.
- Paths must be absolute, normalized and use only `A-Za-z0-9._+@/-`. That keeps systemd units free of quoting and `%`
  specifier surprises.
- An unknown `isolation` id is an error (fail closed).

`existingDaemons` is informational. The tool never manages, modifies or contacts them.

## Use

Run the tests (verified): `npm test`. The command is `paseo-users`; see [13-cli.md](13-cli.md) for the quick start
(`npm run ctl:build && npm link`, then `init`, `add`, `plan`, `render`, `apply`), where its config and rendered files
live, and how to adopt a config like the one above with `paseo-users init --from config.json`.

The older form still works without linking (build first with `npm run ctl:build`; there is no `tsx` in this repo, and Node
cannot run the `.ts` sources directly because they import `.js` paths):

```bash
node dist/tools/ctl/bin.js plan   config.json
node dist/tools/ctl/bin.js render config.json --out ./rendered
node dist/tools/ctl/bin.js revoke-plan config.json bob
```

Only `plan`, `render` (into an empty directory you name) and `revoke-plan` were exercised by hand in development, with
synthetic config. The new commands are covered by tests with fakes; real-host behaviour is UNVERIFIED (see 13).

Same-user people who have a neighbour must carry `"acknowledge": ["shared-provider-history"]` in the config; see 13.

## Recommended order

1. Start with `same-user` for everyone. It needs no new accounts and keeps the logins you already have.
2. Render, review, apply one person, add that host in the app, check the verify list.
3. Move a person to `unix-account` only if you need OS-level separation from the others. Changing `isolation` later
   changes the uid, the home, the `PASEO_HOME` path and the LLM login. Their projects and agent history in the old
   `PASEO_HOME` do not move by themselves; copy them deliberately.

## How people connect

One host entry per daemon. In the app each person adds a host at `<listenAddress>:<port>` and enters their own
password. There is no shared login and no host chooser: two people on one phone have two host entries.
Whether the app can add hosts at arbitrary ports on your network is unverified.

## Review and apply a rendered plan by hand

```text
rendered/
  plan.json        every step, no secrets
  apply.sh         review-only script (mode 0644, not executable); exits unless PASEO_CTL_I_REVIEWED=1
  files/           unit files, laid out as their absolute destination paths
  secrets/         0700: <name>.password, <name>.env (0600)
```

1. Read `plan.json` warnings and `apply.sh` line by line. Every step is one `install`, `mkdir`, `systemctl`, `useradd`
   etc. with a comment saying what it is for.
2. Run the unprivileged phase as yourself, never as root (root-owned files in your home would break the user unit):
   `PASEO_CTL_I_REVIEWED=1 bash apply.sh user`
3. If the plan has `unix-account` people, run the privileged phase: `sudo env PASEO_CTL_I_REVIEWED=1 bash apply.sh root`.
4. For `same-user`, run once as root: `loginctl enable-linger "$(id -un)"` so daemons survive logout and start at boot.
   The tool lists it as a manual step and never runs it.
5. Work through the verify steps in `plan.json` (`verify`): health URL per daemon, distinct homes and ports,
   unreadability between accounts, and that each person has their own host entry. Check provider logins by hand.

The CLI `apply` command does the same through a process runner. It refuses unless `--yes` and
`--i-understand-this-changes-the-host` are both given, refuses if `plan.json` no longer matches the config, runs only
the steps for your privilege (root runs only privileged steps; a normal user only the others), and stops at the first
failure. Prefer the script: you can read it.

## Revocation

`revoke-plan config.json <name> [--out dir]` prints (and optionally renders, into a separate directory) the steps:

- `same-user`: `systemctl --user disable --now`, install a rotated password, a manual reminder to check for leftover
  processes. It cannot stop the person's agents from having read your files.
- `unix-account`: stop and disable the unit, rotated password, `usermod -L`, `loginctl terminate-user`. The home
  directory is kept until you remove it.

Revoking does not remove the person's host entry in their app; it stops answering. Nothing is deleted.

## Unverified

None of these have been exercised on a real host. Check each before relying on it.

- **LLM login sharing** (`same-user`): proven for Claude only (one agent turn). Unproven for Codex and OpenCode. That Claude, Codex and other provider CLIs launched by a user-unit daemon find
  their logins in the user's home exactly as they do from your shell, and that two daemons using one login at once
  work (token refresh, rate limits, session files). Per provider.
- **API keys** (`unix-account`): which environment variables each provider reads, and that `.paseo-provider.env` is
  enough in place of a login.
- **Systemd hardening in a user unit**: `NoNewPrivileges=yes` and `PrivateTmp=yes` taking effect (and not breaking
  agents that use `/tmp`) under `systemd --user`. The daemon starts with them; that agents still work is untested. `ProtectHome` is deliberately not used.
- **Linger**: `loginctl enable-linger` starting user managers at boot and keeping daemons alive after logout, and
  `systemctl --machine=<acct>@.host --user ...` reaching another account's manager.
- **Stopping a unit ends agent processes** the daemon started (control-group kill); `loginctl terminate-user` for accounts.
- The native app holding several host entries on different ports of one address.

Verified by probes on disposable daemons (`PASEO_PROBE=1 npm run test:probes`, installed Paseo 0.17.4, temp homes, loopback):
two daemons started as `daemon run --home <dir>` with `PASEO_LISTEN`, `PASEO_PASSWORD` and `PASEO_RELAY_ENABLED=false`
as plain environment variables run side by side; each rejects the other's password; their project registries are
separate; the same directory can be a project in both (`probes/two-daemons.probe.ts`); `/api/health` answers without the
password. Rendered unit syntax passes `systemd-analyze verify` (the only complaint was the synthetic binary path).

Verified here: config validation, plan contents, render layout and modes, no secrets in plan/units/script, idempotent
re-render and rotation, apply refusal paths, ordered execution and stop-on-failure with a fake runner (`test/ctl/`).
