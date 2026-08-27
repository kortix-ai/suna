# Fast clone path: zero proxied git requests at session boot

Status: implemented on `main` (2026-08-27). Verification numbers below are
from dev; re-run `bun apps/api/scripts/boot-latency-report.ts` for current
values.

## Problem

`repo-materialized` was the largest in-guest boot stage: p50 6.9 s on Platinum
(n=550, 14 d), 7.5 s for a 1-file repo (`octocat/Hello-World`). Bytes were not
the cost. Each git HTTP request through the Kortix git proxy cost ~1.0 s
(sandbox → CF → ECS us-west-2 → ≥6 sequential DB queries in us-east-2 → GitHub
→ back), and the boot made 4–5 of them:

| Step (daemon `materializeRepo`)                    | Requests | Measured    |
| -------------------------------------------------- | -------: | ----------- |
| local clone of `/opt/kortix/scaffold.git`          |        0 | 40 ms       |
| `git fetch origin main` (negotiation over 229 loose objects) | 2–3 | 4.1–6.5 s |
| `git fetch origin <session-branch>` + checkout     |        2 | 2.1–2.6 s   |

Both fetches existed because `KORTIX_SESSION_FRESH` and the fast-boot hint
(`KORTIX_BASE_SHA` + delta bundle) were gated behind experiments that were
off everywhere, and because the bundle covered exactly one commit above the
scaffold, ≤ 24 KiB.

## What changed

1. **Fresh sessions always get the fast path** (`session-runtime-env.ts`):
   `KORTIX_SESSION_FRESH=1`, `KORTIX_BASE_SHA`, the delta bundle and the
   OpenCode config-dir hint are emitted for every new full-repository session.
   Own switch `KORTIX_FAST_GIT_BOOT_ENABLED` (default on; `false` pins it off).
   It is NOT tied to `KORTIX_FAST_COLD_BOOT_ENABLED`: deploy-dev injects an
   explicit `false` for that experiment flag on every push.
2. **Delta = every commit above the scaffold root** (`commits.ts`
   `buildScaffoldDeltaBundle`): boundary is the first-parent root commit; the
   API bundles only when the root's tree equals the current starter scaffold's
   tree (`scaffold-identity.ts`), so imports never bundle their whole history.
   ≤ 24 KiB base64 rides the env; larger deltas are `KORTIX_GIT_DELTA_BUNDLE_REMOTE=1`
   and the daemon downloads `GET /v1/git/<project>.git/fast-boot-bundle?ref&tip&parent`
   (one authenticated request, served from the API mirror, disk-cached, ≤ 64 MiB).
3. **Fallback fetch is one round trip**: `git fetch --depth 1 --no-tags` instead
   of a negotiated fetch; `scheduleHistoryBackfill` restores history afterwards.
4. **Proxy tax cut** (`projects/lib/git.ts`, `git-proxy/index.ts`): the project
   row and the token row are looked up concurrently; a positive authorization
   verdict is memoized 30 s per (token, project, scope) — denials never are; the
   resolved upstream (URL + host credential) is memoized 30 s per (project, scope).
5. **OpenCode spawns before the checkout** (`main.ts`): the API resolves the
   OpenCode config dir at the base tip from its mirror
   (`opencode-config-dir.ts`) and ships `KORTIX_OPENCODE_CONFIG_DIR_HINT`. The
   daemon spawns OpenCode on that dir at `proxy-up`, concurrently with
   materialization. After the repo lands it installs config deps + injected
   skills and disposes the instances in place (`reloadForWorkspace`, ~50 ms) so
   the next directory-scoped request re-detects the git root and re-reads the
   config. A hint that does not match the checkout restarts OpenCode (rare).
   No hint → the previous serial boot.

## Boot marks

`opencode-spawned` now lands before `repo-materialized` when the hint is
present; `opencode-workspace-reloaded` marks the in-place reload.

## Verification

- API: `cd apps/api && bun test --isolate --env-file=scripts/test.env
  src/projects/git/fast-boot-bundle.test.ts src/projects/lib/fast-boot-git-hint.test.ts
  src/projects/lib/session-runtime-env.test.ts src/__tests__/unit-git-proxy-authz.test.ts`
- Daemon: `cd apps/kortix-sandbox-agent-server && bun test src/__tests__/fast-boot-delta.test.ts`
  (inline multi-commit bundle, remote bundle download, depth-1 fallback,
  foreign-scaffold rejection, config-dir hint mapping).
- Dev: new sessions on a managed project; `boot_timeline` in
  `GET <sandbox_url>/kortix/health`; `bun apps/api/scripts/boot-latency-report.ts`.

## Rollback

`KORTIX_FAST_GIT_BOOT_ENABLED=false` on the API restores the pre-2026-08-27
env contract (no fresh-session hints). The daemon paths are additive: without
the env they run the previous scaffold-fetch / clone code.
