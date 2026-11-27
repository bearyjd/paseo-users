## What and why

<!-- One or two sentences. Link the issue if there is one. -->

## Security impact

<!-- Delete the lines that do not apply. -->
- [ ] No change to authentication, authorization, session handling, credentials or the store format
- [ ] Authorization decisions are made server-side from a resolved principal, never from client-supplied ids
- [ ] New behaviour fails closed (unknown role, resource or missing capability denies)
- [ ] No secrets, host names, user names, paths or addresses in code, tests, docs or logs

## Verification

- [ ] `npm run check` passes locally
- [ ] Tests added or updated for the change (a security fix has a test that failed before it)
- [ ] If this touches the daemon-facing provider or the planner against a real host: `PASEO_PROBE=1 npm run test:probes` was run against a **disposable** daemon

**Verified:** <!-- what you ran and saw -->
**Not verified:** <!-- what remains untested; say so plainly -->

## Docs

- [ ] Docs updated where behaviour changed (capability matrix and threat model if a blocker or threat moved)
- [ ] `CHANGELOG.md` updated for anything user-visible
