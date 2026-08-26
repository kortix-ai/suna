# Deploy to dev — auto on push, cancel-stale, with a manual override

**Dev auto-deploys on every push to `main`.** Each push builds only the surfaces
that changed vs what dev currently runs, on the LATEST commit, and a newer push
CANCELS the in-progress deploy so dev always converges to newest. There is also a
manual **Deploy Dev** button (`workflow_dispatch`) to force a full/frontend
redeploy on demand.

## The model

- **Trigger:** `on: push` to `main` + `workflow_dispatch`.
- **Cancel-stale:** `concurrency.cancel-in-progress: true` — a newer push kills a
  superseded deploy. Safe here because (1) the single-arch amd64 API build is
  ~4–7 min and outruns the push cadence, and (2) detect-changes diffs against
  dev's LIVE SHA, so a surface whose deploy was cancelled is still stale-vs-dev
  and the next push rebuilds it — a cancel can't strand a surface.
- **Changed-only:** detect-changes reads dev's live SHA from
  `dev-api.kortix.com/v1/health` and builds only surfaces stale vs it; if that
  SHA can't be resolved it FAILS SAFE and builds everything.

`staging` and `prod` are unaffected — promote-gated, never per-push (see the
`kortix-release` skill).

## Manual deploy (override)

You rarely need this — push already deploys. Use it to force a full or
frontend-only redeploy:

1. **GitHub UI** — Actions tab → **Deploy Dev** → **Run workflow** → pick a
   `surface` → **Run workflow**.
2. **CLI** — `gh workflow run deploy-dev.yml -f surface=all` (or `frontend` / `changed`).

### The `surface` input

| value | what it builds + deploys | when |
| --- | --- | --- |
| `changed` (default) | only the surfaces STALE vs the SHA dev is currently running | the normal case — fast, skips unchanged surfaces |
| `all` | force-rebuild + redeploy every surface (API, gateway, frontend, CLI, terraform) | recovery, or when you want a guaranteed full refresh |
| `frontend` | the frontend only | a frontend-only change, or to re-ship a stale frontend |

`changed` reads dev's live SHA from `dev-api.kortix.com/v1/health` and diffs
against it, so a surface changed by any commit since the last dev deploy
rebuilds — regardless of how the pushes were grouped. If that SHA cannot be
resolved (health down, force-push, first deploy), it FAILS SAFE and builds every
surface.

## Verify a deploy landed

A green run is not proof by itself. Confirm the deployed artifact carries the
SHA you deployed:

- **API:** `curl -s https://dev-api.kortix.com/v1/health` → `.commit` is your
  merge SHA (or has it as an ancestor).
- **Frontend:** `curl -s https://dev.kortix.com/api/health` → `.commit` likewise.
- Then exercise the actual user-visible behavior against the deployed surface
  (see CLAUDE.md "Default delivery" step 5).

## Common traps

- **Stale browser tab mimics a stale deploy.** `dev.kortix.com` is a single-page
  app; an open tab keeps running the JS bundle it loaded before the deploy. If
  the UI looks old but `/api/health` reports the new commit, hard-reload
  (Cmd/Ctrl+Shift+R). The deploy is fine.
- **Cancel-stale is intentional.** `cancel-in-progress: true` — a newer push
  cancels an in-flight deploy so dev converges to newest. A cancelled run is
  normal, not a failure. (This was `false` from 2026-08-10 to 2026-08-20 after
  `true` caused a 3.5h outage on a ~23-min multi-arch build; the single-arch
  speedup + diff-vs-deployed detect-changes removed that hazard — see the
  `learnings` skill.)
- **Cancelled `migrate-db` is recoverable.** node-pg-migrate wraps each step in a
  transaction (a killed ordinary migration rolls back, the next deploy re-applies
  it); a `.concurrent` migration can leave an INVALID index — drop+rebuild it by
  hand (learnings: "CREATE INDEX CONCURRENTLY under lock_timeout").

## Build speed

Dev builds are single-arch amd64 (dev Fargate is x86_64), with registry layer
cache. The API image builds in ~4–7 min (was ~22 min when it emulated arm64 that
dev never runs). `deploy-prod.yml` keeps multi-arch — that is prod's concern, not
dev's.

## Related

- `.github/workflows/deploy-dev.yml` — the workflow itself.
- `kortix-release` skill — how prod releases work (promote, not dispatch).
- `learnings` skill — the concurrency and frontend-skip incidents behind this design.

## Runners

Every Linux job in this workflow runs on Blacksmith through the
`${{ vars.CI_RUNNER_* || '<label>' }}` expression. Tiers, the kill switch to
GitHub-hosted runners, the Docker layer cache, and how to read queue time:
`docs/runbooks/ci-runners.md`.
