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
