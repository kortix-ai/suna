# Preview environments (per-PR)

The `preview` label gives a pull request its own complete Kortix deployment. Use it to share,
review, and record work without merging. The workflow is `.github/workflows/deploy-preview.yml`.
The deploy logic is `tests/bin/sandbox-preview.ts`, `tests/src/core/sandbox-preview.ts`, and
`tests/src/core/preview-stack.ts`.

## What you get

- One persistent Platinum sandbox per **branch**, named `kortix-env-<branch-slug>`
  (8 CPU, 16 GB RAM, 50 GB disk).
- Inside it, `kortix self-host init` plus Docker Compose runs the API, the LLM gateway, the web
  frontend, Supabase, PostgreSQL, Mailpit, and a Caddy edge. The images are built from the PR
  head commit and pushed as `kortix/kortix-{api,gateway,frontend}:pr-<sha>`.
- Its own database. The database is not shared with dev or staging and is not seeded. It
  persists across pushes.
- One HTTPS origin, issued by Platinum: `https://8080-<sandbox-id>.<region>.sbx.platinum.dev`.
  The origin is stable for the life of the branch.

Paths on the origin:

| Path | Serves |
| --- | --- |
| `/` | web frontend |
| `/v1/*`, `/health` | API |
| `/auth/v1/*`, `/rest/v1/*`, `/storage/v1/*` | Supabase |
| `/_gateway/*` | LLM gateway |
| `/_mailpit/api/v1/*` | Mailpit API: every email the preview sends. The web UI at `/_mailpit/` renders blank because its assets load from `/dist/`, outside the prefix. Use the API. |
| `/_tests/` | `--target-full` reports, one folder per run |

## Find the origin

```bash
.agents/skills/contributing/scripts/preview-origin.sh <pr>          # newest live origin, warns if it serves an older commit
.agents/skills/contributing/scripts/preview-origin.sh <pr> --wait   # blocks until the PR head commit is live
```

The script reads the GitHub deployment for environment `preview/pr-<N>`. The same URL
appears in the sticky PR comment that starts with `<!-- preview-status -->`. That comment
also gives the test state:

- `live and tested`: `--target-full` passed on this commit.
- `live; NOT tested`: a push redeploy. The suite did not run.
- `live; tests failed`: the environment is up. Read `/_tests/` and the run log.
- `deployment failed`: no origin was published. Read the run log. The environment can still
  be up: when `--target-full` hits the 90-minute worker cap (`Platinum worker exceeded
  5400000ms`), the job fails after the deploy. Find the origin in the log
  (`grep -o 'https://8080-[^ ]*sbx.platinum.dev'`) and check `<origin>/health`. Its `commit`
  field names the deployed SHA. Push, or re-add the label, to publish it again.

## Sign in

- Sign-up is open, with magic link and password. Email auto-confirm is off.
- `.agents/skills/contributing/scripts/preview-sign-in.sh <origin> <agent-browser-session>`
  signs a new synthetic user (`pr-demo-<epoch>@example.test`) in to that browser session.
- It is built on `preview-auth-email.sh <origin> <email> <since-epoch>`, which reads the
  newest auth email from Mailpit. It prints the verify link, or the 6-digit code when the
  email has no link. Use that script alone for a non-browser flow.
- Billing is on with Stripe test mode. A new account is free tier, and its agents answer with
  the faux model provider. For real model output, subscribe with a Stripe test card
  (`4242 4242 4242 4242`) or connect a BYOK key.
- OAuth sign-in is not available on a preview.

## Lifecycle

| Event | Result |
| --- | --- |
| `preview` label added | Build, deploy, then run `pnpm test -- --target-full` (~14 min total). |
| Push to a labelled PR | Redeploy in place (~8 min). The database is kept. The suite is skipped. |
| Label removed and re-added, or `gh workflow run deploy-preview.yml -f pr_number=<N>` | Full deploy with the suite. |
| Label removed | Environment torn down. |
| Branch deleted (including auto-delete on merge) | Environment torn down. |
| PR closed, branch kept | **Keeps running.** Remove the label. |
| Daily at 06:17 UTC | Reconciler deletes environments whose branch no longer exists. |

- One deploy runs per PR at a time. Later ones queue. A push during a deploy makes the
  running deploy fail as stale, and the queued one deploys the new head.
- Sessions inside a preview stop after 6 h idle (provider backstop: 60 min).

## Constraints

- **Same-repo branches only.** Fork PRs never get a preview.
- **The actor who adds the label needs write access.** The workflow checks it twice.
- **`pull_request_target` runs the workflow from `main`.** A change to `deploy-preview.yml`
  or `tests/bin/sandbox-preview.ts` on a branch takes effect only after it merges.
- **The shared Platinum pool is 512 GB, and each preview takes 16 GB.** A full pool fails
  deploys with `429 org RAM pool is full`. Remove labels you no longer need.
- **Only an allowlist of runtime secrets reaches a preview** (`preview-stack.ts`). The
  preview GitHub App cannot create repositories.
- **The edge drops request bodies over ~124 KiB.** Uploads use chunked mode.
- **A failed migration** prints the `kortix-migrate` logs and restores the last good image set.

## Not the same thing

The sandbox preview origins (`*.p.kortix.com`, `configure-preview-edge.yml`) expose ports
from inside session sandboxes on dev, staging, and prod. They are unrelated to PR previews.
