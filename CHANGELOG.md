# Changelog

All notable changes. Format follows Keep a Changelog; versions follow SemVer once 0.1.0 is cut.

## [Unreleased]

### Added
- Daemon-facing admission provider (`server/admission.ts`): per-login-session principals, provider-hosted
  `/api/auth/*` account API (login, logout, me, sessions, create user, disable, revoke), fail-closed developer
  handling, revoke events. First-run `init` and `PASEO_ADMISSION_MODULE` entry; `npm run build` emits `dist/`.
- Kernel `onSessionsRevoked` hook and `InvalidInputError` (400, not 409).
- End-to-end probes against a daemon built from the `feat/users-admission` core branch.
- Research findings: current Paseo auth architecture, plugin SDK capability matrix, security architecture,
  threat model, core-extension requirements, data model, roadmap, Profiles contract, test plan (`docs/`).
- Identity and authorization kernel (`server/kernel`): scrypt passwords, login sessions, throttling, invitations,
  resets, roles, project/session isolation decisions, allowances, audit, JSON store with migration and rollback.
- Fail-closed daemon-permission mapping and Profiles integration contract v1.
- Plugin entry with a read-only `users.status.get` RPC reporting `enforcement: "none"`.
- Disposable-daemon probes confirming upstream blockers and plugin load.
