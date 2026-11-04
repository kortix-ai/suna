---
recorded: 2026-10-30T16:59:37Z
incident_date: 2026-10-30
---
# Chmod every file a sandbox image runs to an explicit mode, never +x: a context staged under umask 007 drops world-read

**Rule:** A Dockerfile layer that installs a script or binary the `kortix`
user runs sets its mode with an explicit octal (`chmod 0755`), never `chmod
+x`. `COPY` keeps the build context's mode, and a context staged on a box with
umask 007 (a PTXP box) has files at `0770`: `+x` makes them `0771`, which the
non-root user cannot read, so a script cannot start.

**Trigger surface:** Editing `packages/shared/src/sandbox/dockerfile-layer.ts`
or `meta-dockerfile.ts`, or building a sandbox snapshot from a local stack on
a PTXP box.

**Incident:** 2026-10-30, worktree stack on a PTXP box (branch
`cloud-agents`, PR #11230). The default image built from the worktree had
`/usr/local/bin/kortix-entrypoint` at `-rwxrwx--x`. Boxes booted from it logged
`bash: /usr/local/bin/kortix-entrypoint: Permission denied` in
`/var/log/pt-app.log` and the daemon never answered on port 8000; sessions
stayed "working" with no turn (2 of 2 boxes, ~25 min of debugging). Earlier
images built from the same box booted on other hosts. Prod and dev images
are built in CI (umask 022) and were not affected. The meta image already used
`chmod 0755`. `apps/api/src/snapshots/app-build-context.test.ts` fails on the
same boxes (expects `0644`, gets `0640`).

**Enforcement:** `packages/shared/src/sandbox/__tests__/layer-render.test.ts`
pins the rendered layer, so a change back to `+x` shows in the snapshot diff.
None yet for the other `COPY`'d trees (slack-cli, MACHINE.md, managed
skills): a build-context test under `umask 007` is the enforcer to build.
