# Changelog

All notable changes. Format follows Keep a Changelog; versions follow SemVer once 0.1.0 is cut.

## [Unreleased]

### Added
- Research findings: current Paseo auth architecture, plugin SDK capability matrix, security architecture,
  threat model, core-extension requirements, data model, roadmap, Profiles contract, test plan (`docs/`).
- Identity and authorization kernel (`server/kernel`): scrypt passwords, login sessions, throttling, invitations,
  resets, roles, project/session isolation decisions, allowances, audit, JSON store with migration and rollback.
- Fail-closed daemon-permission mapping and Profiles integration contract v1.
- Plugin entry with a read-only `users.status.get` RPC reporting `enforcement: "none"`.
- Disposable-daemon probes confirming upstream blockers and plugin load.
