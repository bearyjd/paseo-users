# Contributing

1. `npm install && npm run check` must pass. Add tests with every behaviour change; security fixes need a failing
   test first (cross-user access, escalation, disclosure).
2. Keep the kernel free of Paseo imports. Paseo-specific wiring lives behind the interfaces in
   `docs/05-core-extension-requirements.md`.
3. Follow Paseo plugin conventions: code only in `server/`, `shared/`, `client/` plus `index.*`; shared code imports
   no Node/React; Zod for every persisted or wire shape.
4. Small, logical commits with conventional prefixes (`feat:`, `fix:`, `docs:`, `test:`, `chore:`).
5. Dependencies: pin exact versions for `@getpaseo/plugin`; keep the runtime footprint to Node built-ins + `zod`.
   Justify any new runtime dependency in the PR.
6. Never commit secrets or deployment-specific values (hostnames, usernames, addresses, paths). Those belong in the
   operator's own config repository.
7. Probes and tests that start a daemon must use `probes/daemon-harness.ts` (temp home, ephemeral port, synthetic
   credentials). Never target a production daemon.
8. Do not weaken a security requirement to make a feature fit; document the blocker instead.
9. Licensed Apache-2.0; by contributing you agree your contribution is under the same terms.

## Pull requests

`main` is protected: changes land through a pull request, squash-merged, with the `check` job green and conversations
resolved. Maintainers can still push directly in an emergency; avoid it.

1. Branch from `main` (`feat/…`, `fix/…`, `docs/…`, `chore/…`) and keep the PR to one logical change.
2. Run `npm run check` before pushing. The PR template asks what you verified and what you did not; answer honestly.
3. CI runs on every PR: typecheck, unit tests, the provider and planner builds, and the static SDK probe (`ci`); static
   analysis (`codeql`); and a vulnerable-dependency check (`dependency-review`). Only `check` is required to merge.
4. Probes that start a daemon are opt-in and never run in CI. Run them locally against a **disposable** daemon.
5. The squash commit message is the PR title plus body: write the title as a conventional commit (`feat:`, `fix:`, …).
6. Anything touching authentication, authorization, sessions, credentials or the store format also updates
   `docs/04-threat-model.md` and the capability matrix when a threat or blocker moves.

Dependency updates arrive as Renovate PRs (weekly, grouped for dev dependencies). `@getpaseo/plugin` is bumped by hand
together with the Paseo version in `paseo-plugin.json`.
