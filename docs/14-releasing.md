# 14 — Releasing and listing

How to cut a release and list the plugin in the Paseo plugin registry. The registry steps come from
<https://paseo.sh/docs/plugins/publishing.md>, read on 2026-11-27. The registry's own review policy
(`getpaseo/plugins` `REVIEW.md`) was **not** read; check it before submitting. Nothing here has been run end to end.

## What 0.1.0 is

A pre-release. On stock Paseo the plugin enforces nothing and `users.status.get` reports `enforcement: "none"`. Do not
describe it as secure multi-tenancy. `OVERVIEW.md` says the same, and the registry shows that file to users.

## Cut a release

1. Move `[Unreleased]` entries in `CHANGELOG.md` under a dated `## [x.y.z]` heading.
2. Set the version in **both** `package.json` and `PLUGIN_VERSION` in `server/status.ts`. They are not linked.
3. Update `requirements.paseo` in `paseo-plugin.json` if the supported Paseo range changed.
4. `npm run check`, then `npm pack --dry-run --ignore-scripts` and confirm `OVERVIEW.md` and `paseo-plugin.json` are in it.
5. Merge to `main` through a pull request.
6. Tag the merge commit on `main`: `git tag -a vX.Y.Z -m "paseo-users X.Y.Z"` then `git push origin vX.Y.Z`.
   Tag after the merge. A tag on a branch commit can point at a commit a squash merge removes.
7. Create a GitHub release from the tag with the changelog section as the notes, including the pre-release warning.

## List in the registry

1. The GitHub repository must be public.
2. `OVERVIEW.md` sits beside `paseo-plugin.json` at the tagged commit. It must not contain install commands
   (`paseo plugin add`, `npm install`, `npm i`). The validator rejects them.
3. `paseo-plugin.json` has a one-sentence `description`.
4. Open the submission form at <https://github.com/getpaseo/plugins/issues/new?template=submit-plugin.yml>. Give the
   repository URL and the tag. A bot opens a review PR and the reviewer records the approved commit.
5. Answer review comments on that PR. For a later version, resubmit with the new tag.

`package.json` keeps `"private": true`. The Git route does not need it removed. Publishing to npm would also need
`npm pkg delete private`, a name you own on npm, and an `npm-shrinkwrap.json` if runtime dependencies are added.
