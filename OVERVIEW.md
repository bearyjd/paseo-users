Paseo Users is a pre-release identity and authorization kernel for running Paseo with more than one person. It provides accounts, roles, login sessions, project ownership and sharing, and an audit log. It is not an access boundary yet. Installed on a stock Paseo daemon, it enforces nothing, and it says so.

## What it does today

The plugin adds one read-only call, `users.status.get`. It reports the plugin version and `enforcement: "none"`, plus the list of daemon capabilities that are still missing. Nothing else changes in your daemon, and the plugin does not create accounts or sessions.

The accounts, sessions, roles and authorization logic are in the package and covered by unit tests. They are not connected to your daemon's logins, listings or file access, because Paseo currently admits one shared owner with every permission and gives plugin handlers no caller identity. A plugin cannot change that.

## Two ways to use the project

- **One daemon per person.** No core changes. A planner in the repository (`tools/ctl`) writes the steps to run one Paseo daemon per person on the same host, under your own Linux user or under separate ones. It only plans and renders; it has not been applied to a real host.
- **One daemon for many users.** Needs a patched Paseo core. The repository documents the required changes, and a local core branch exists that signs administrators in as distinct principals. Developer accounts are refused there until core can scope resources.

## Requirements

- Paseo 0.17.4 or later in the 0.17 series, as set in the manifest.
- Node.js 22 or later.
- Tested on Linux only.

## Data

The plugin does not send data anywhere and makes no network calls. The kernel stores its state in a directory inside the daemon's plugin data folder, with owner-only permissions. Passwords are stored as scrypt hashes and session tokens as hashes. The audit log does not record secrets.

## Known limits

- Do not describe this as secure multi-tenancy. Even with the core changes, agents that run under the same Unix account can read each other's files. Real isolation needs separate accounts, containers or virtual machines.
- There is no login or admin screen, no per-user listings or events, no live-socket revocation through the stock daemon, and no link between device pairing and users.
- The threat model and the full list of required core changes are in the `docs` folder of the repository.
