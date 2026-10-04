---
name: contributing
description: "The pull request loop for this repo: branch → commit → verify in your own box (local tests + local stack) → PR into main → demo video recorded with agent-browser on the local stack → `gh --attach` → self-merge → verify on dev. A PR into main runs no CI unless a person adds the `test` or `preview` label (one run each). Load when opening, updating, or finishing a pull request; when writing a PR body; when asking what CI runs where; when adding or explaining PR labels or the per-PR preview environment; or when attaching an image or video to a PR, issue, or comment."
---

# Contributing: the pull request loop

Every change reaches `main` through a pull request. A pull request into `main` runs **no**
GitHub Actions job: your development machine runs every test, the stack, and the demo before
the PR opens, and the PR is mergeable at once. Each PR carries a demo video of the change,
recorded with **agent-browser** against your local stack. The video is uploaded with `gh --attach` and appears
in the PR body. This skill is that loop, end to end.

`AGENTS.md` owns the policy: canonical branches, when to self-merge, and the customer-data
rule. This skill is the procedure. Read `AGENTS.md` → "First, at session start" and
"Default delivery" before step 1 if you have not.

## Preflight (once per machine)

```bash
gh --version                 # ≥ 2.99.0: first release with --attach
agent-browser --version      # installed: npm i -g agent-browser && agent-browser install
agent-browser doctor         # "Recording" must pass: ffmpeg with libvpx + libx264
gh auth status               # token prefix gho_, ghp_, or github_pat_ (see attachments reference)
```

Done when all four pass. A `ghs_` or `ghu_` token cannot attach. See
[references/attachments.md](references/attachments.md) → "Token types".

## Steps

### 1. Branch and worktree

Join the canonical branch for the work, or create one:
`pnpm worktree create --name <slug> --yes --no-start` (the **worktree** skill). All edits and
runs happen under `../suna-<slug>`.

Done when `git branch --show-current` prints the canonical branch inside its worktree.

### 2. Commit

- Use the Conventional Commits subject style that `git log` shows:
  `fix(sandbox): …`, `feat(web): …`, `refactor(api): …`, `docs(repo): …`.
- `pnpm install` arms `.githooks`. The hooks encrypt staged `.env` files, block plaintext
  secrets, and refuse blocked customer terms. When a hook fires, fix the content and commit
  again. Keep the hooks on every commit (never `--no-verify`).
- Ship the tests with the behaviour change (the **testing** skill).

Done when the commit exists and the hooks passed.

### 3. Verify in your box

Run the narrowest relevant test first, then `pnpm test` (the **testing** skill). Then run
the changed behaviour on your worktree's stack: `pnpm worktree start <slug>` prints the web
and API ports. Exercise the real surface: the HTTP route with `curl`, the real CLI process,
or the page with agent-browser. No CI lane runs these for you before the merge.
`pnpm test` writes `tests/attestations/<branch>.json` and deletes every other file
there: commit `tests/attestations/` (`git add -A tests/attestations`). If a merge of
`origin/main` conflicts on the legacy `tests/test-attestation.json`, delete it. The pre-push hook and the
merge gate run `pnpm test:verify` against the pushed head and reject a stale or red
attestation. Never push with `--no-verify`.

Done when the commands you will list under "How was this tested?" passed, with output
captured.

### 4. Record the demo video on the local stack

The demo is a short video of the changed behaviour on a real surface: your worktree's web
app (`http://localhost:<web port>`). Run it as a bash script from the repo root. zsh does
not word-split, so a command stored in a variable fails there.

```bash
#!/usr/bin/env bash
set -euo pipefail
S=http://localhost:<web port>        # from `pnpm worktree start <slug>` or `pnpm worktree ls`
SESSION=$(agent-browser session id --scope worktree --prefix pr-demo)
ab() { agent-browser --session "$SESSION" "$@"; }

# Sign in before recording, so the video never shows an auth form.
.agents/skills/contributing/scripts/preview-sign-in.sh "$S" "$SESSION"   # prints the synthetic email

mkdir -p output/pr
ab set viewport 1440 900
ab open "$S/<changed route>"
ab wait --load networkidle          # record a rendered page, not a hydrating one
ab record start output/pr/demo.mp4 --cursor
#   Drive the change: `ab snapshot -i`, then `ab click @eN`, `ab fill @eN …`.
#   Put `ab wait 800` between actions so a person can follow.
ab record stop
ab close
```

`preview-sign-in.sh` creates `pr-demo-<epoch>@example.test` and requests the sign-in email.
On a local origin it reads the link or code from local Supabase's Mailpit
(`127.0.0.1:54324`), and it waits until the browser leaves `/auth`. Load
`agent-browser skills get core` for the full command set.

Rules for the video:

- Show the change, from the starting state to the visible result, in under 60 s. One flow
  per video. Use more videos for more flows.
- Use synthetic data only (`@example.test` emails, invented names). The repo is public, and
  every attachment URL is public.
- `.mp4` plays in every browser. Keep each file under 100 MB (`ls -lh output/pr/`).
- For a change with no UI (API, CLI, infra), record the terminal output or the rendered
  result on GitHub. For example, open the changed file on the branch at
  `https://github.com/kortix-ai/suna/blob/<branch>/<path>`. Or state in the PR why a video
  adds nothing.

Look at the video before you attach it. Extract four frames and read them:

```bash
for t in 1 5 10 15; do ffmpeg -v error -y -ss $t -i output/pr/demo.mp4 -frames:v 1 -vf scale=720:-1 output/pr/frame-$t.png; done
```

Blank frames mean the page had not rendered. An oversized pointer means the page's CSS
broke the `--cursor` overlay: record that page without `--cursor`.

Done when the frames show the change from start to result, with only synthetic data.

### 5. Open the PR

```bash
git push -u origin HEAD
gh pr create --base main \
  --title "<type>(<scope>): <what changed>" --body-file output/pr/body.md \
  --attach ./output/pr/demo.mp4
```

- Build `body.md` from `.github/pull_request_template.md`, with every section filled. The
  line `![Demo](./output/pr/demo.mp4)` holds the video; `--attach` uploads it and rewrites
  the path in one step, so skip step 6.
- Put `body.md` and the recordings in the gitignored `output/pr/` directory. Keep them out
  of tracked paths.
- Open it as a draft (`--draft`) only when the work is not finished. A verified change goes
  straight to review-ready.
- The PR runs no CI job. Add `test` or `preview` only when you need that one explicit run. See "What runs where" and "Labels" below.

Done when `gh pr view --json url` prints the PR.

### 6. Attach the video to the PR

```bash
# body.md contains the line:  ![Demo](./output/pr/demo.mp4)
gh pr edit <pr> --body-file output/pr/body.md --attach ./output/pr/demo.mp4
```

`gh` uploads the file to GitHub and replaces the local reference in the body with the
uploaded URL. The URL renders as a video player. Run the command from the directory the
body's relative paths resolve from: the repo root. The full rules and failure modes are in
[references/attachments.md](references/attachments.md).

Done when the body has the asset URL and no local link is left:

```bash
gh pr view <pr> --json body --jq .body | grep -oE 'https://github.com/user-attachments/assets/[0-9a-f-]+'  # ≥ 1 URL
gh pr view <pr> --json body --jq .body | grep -cE '\]\(\./output/'                                        # 0
```

### 7. Keep it current

- Keep the PR mergeable: `gh pr view <pr> --json mergeable` must not say `CONFLICTING`.
  Merge `main` into the branch and push.
- When the behaviour in the video changes, record the video again and repeat step 6.
- Edit the body after an upload from the live copy:
  `gh pr view <pr> --json body --jq .body > output/pr/body.md`. The old local file still holds
  `./output/pr/demo.mp4`. `--body-file` without `--attach` would publish that path as a broken
  link.
- Merge `main` into the branch daily. Git's rename detection carries `main`'s edits
  through moved files. GitHub's conflict check does not, so push the merge.

### 8. Merge and hand off

- Self-merge when the change is verified (`AGENTS.md` → "Default delivery", rule 5): the
  local checks passed and the PR is mergeable. Do not wait for the user's approval, and do
  not wait for a CI check: none runs. `gh pr merge <pr> --squash`.
- A push to `main` does not deploy dev and does not run `Tests`. Deploy deliberately:
  `gh workflow run deploy-dev.yml -f surface=changed` (`changed` ships every merge since
  dev's live SHA; `all` forces every surface; `frontend` builds the web app only). Follow the
  run to the "Live on dev" comment, then verify the change on dev.
- Report the PR URL, the merge SHA, the local test commands and their results, the dev
  verification, and anything still unverified.
- Merging into `staging` or `prod`, and every release step, still needs the user's explicit
  approval (the **kortix-release** skill).

## What runs where

| Event | Workflows | Blocks? |
| --- | --- | --- |
| PR into `main` | none. Adding `test` runs the six `Tests` lanes once (~9 min); adding `preview` deploys once (~7 min), with no tests. A push re-runs neither. | no |
| Push to `main` (the merge) | `secret-scan`, `secrets-guard`, path-gated `DB Migrations`, `i18n-catalogs`, `deploy-api-router-dev`, `Terraform Apply Global`. Nothing else. | no |
| Dispatch / schedule on `main` | `Deploy Dev` and `Desktop`: dispatch only. `Tests`: daily. `drata`: daily. `CI`, `CodeQL`: weekly. | no |
| PR into `staging` | the six `Tests` lanes, `CI`, `CodeQL`, `secret-scan`, `secrets-guard`, path-gated `DB Migrations`, `Terraform CI`, `Security Scan`, `i18n-catalogs`, `drata` | release discipline |
| PR into `prod` | the same scanners plus `tests-release.yml`; its `full suite + quality gates` check is the only required check in the repo | yes |

`tests/unit/sandbox-workflow.test.ts` fails when a workflow other than the label-gated
`tests.yml` and `deploy-preview.yml` triggers on a pull request into `main`. Move a new check to a schedule, a dispatch, or the release
PRs, never to PRs into `main`. Add it to `push: main` only when it takes seconds: a
push runs on GitHub-billed minutes, and the factory merges ~37 PRs a day.

## Labels

| Label | Effect | Who can add it |
| --- | --- | --- |
| `test` | Runs the six `Tests` lanes (~9 min) once, on the head SHA when the label is added. A push does not re-run it; remove and re-add the label to run again. | Triage access. |
| `preview` | Builds one self-host environment for the branch on Platinum (~7 min), once, and runs no tests. A push does not redeploy; re-add the label. Removing the label tears it down. `gh workflow run deploy-preview.yml -f pr_number=<N>` redeploys and runs `pnpm test -- --target-full` (40–80 min). See [references/preview-environments.md](references/preview-environments.md). | Needs write access, and a PR from a branch of this repo (not a fork). |
| `i18n-reorder` | Lets `i18n-catalogs.yml` accept an intentional key reorder in `apps/web/translations/*.json` on a release PR. On `main`, the same reorder needs `I18N_REORDER=1` past `.githooks/pre-commit` and the commit trailer `I18n-Reorder: intentional`. | Triage access. |

Both labels are explicit, rare requests. Never add one by default, from a template, or from
automation.
