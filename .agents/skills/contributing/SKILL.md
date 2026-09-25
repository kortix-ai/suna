---
name: contributing
description: "The pull request loop for this repo: branch → commit → draft PR → `preview` / `test` labels → preview environment → demo video recorded with agent-browser → `gh --attach` → merge handoff. Load when opening, updating, or finishing a pull request; when writing a PR body; when adding or explaining PR labels or the per-PR preview environment; or when attaching an image or video to a PR, issue, or comment."
---

# Contributing: the pull request loop

Every change reaches `main` through a pull request. Each PR carries a demo video of the
change, recorded with **agent-browser**. The video is uploaded with `gh --attach` and appears
in the PR body. This skill is that loop, end to end.

`AGENTS.md` owns the policy: canonical branches, merge approval, and the customer-data
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

### 3. Open a draft PR with the `preview` label

```bash
git push -u origin HEAD
gh pr create --draft --base main --label preview \
  --title "<type>(<scope>): <what changed>" --body-file <body.md>
```

- Build `<body.md>` from `.github/pull_request_template.md`, with every section filled.
  Leave the demo video line as a local path for now (step 6 replaces it).
- Video already recorded (local stack, or no UI)? Add `--attach ./output/pr/demo.mp4` to
  `gh pr create`. That uploads the video and rewrites the path in one step, so skip step 6.
- Put `body.md` and the recordings in the gitignored `output/pr/` directory. Keep them out
  of tracked paths.
- The `preview` label builds a full self-host environment for the branch and runs the
  six-lane `Tests` suite. See [references/preview-environments.md](references/preview-environments.md).
  Add `test` instead when the change needs CI tests but no environment.

Done when `gh pr view --json url,isDraft,labels` shows the draft PR with its label.

### 4. Verify locally while the preview builds

Run the narrowest relevant test first, then `pnpm test`. CI does not run the suite on a PR
into `main` without a label.

Done when the commands you will list under "How was this tested?" passed, with output
captured.

### 5. Record the demo video on the preview

The demo is a short video of the changed behaviour on a real surface. Record on the PR's
preview origin by default. Use the local stack (`pnpm dev`) only when the change cannot
reach a preview.

Run it as a bash script from the repo root. zsh does not word-split, so a command stored
in a variable fails there.

```bash
#!/usr/bin/env bash
set -euo pipefail
PR=<pr>
S=$(.agents/skills/contributing/scripts/preview-origin.sh "$PR" --wait)   # blocks until the head commit is live
SESSION=$(agent-browser session id --scope worktree --prefix pr-demo)
ab() { agent-browser --session "$SESSION" "$@"; }

# Sign in before recording, so the video never shows an auth form.
.agents/skills/contributing/scripts/preview-sign-in.sh "$S" "$SESSION"   # prints the synthetic email

mkdir -p output/pr
ab set viewport 1440 900
ab record start output/pr/demo.mp4 "$S/<changed route>" --cursor
#   Drive the change: `ab snapshot -i`, then `ab click @eN`, `ab fill @eN …`.
#   Put `ab wait 800` between actions so a person can follow.
ab record stop
ab close
```

`preview-sign-in.sh` creates `pr-demo-<epoch>@example.test` and requests the sign-in email.
It reads the link or code from the preview's Mailpit and waits until the browser leaves
`/auth`. Load `agent-browser skills get core` for the full command set.

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

Done when `output/pr/demo.mp4` exists, plays, and shows the change end to end.

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

### 7. Keep it green and current

- Keep the PR mergeable: `gh pr view <pr> --json mergeable` must not say `CONFLICTING`.
  While it conflicts, GitHub runs no `pull_request` workflow (CI, `Tests`, secret scans).
  Only the preview runs. Merge `main` into the branch and push.
- A push redeploys the preview in place. That redeploy skips `--target-full`, and the
  sticky comment says `live; NOT tested`. Remove and re-add `preview` to test the new
  head commit.
- When the behaviour in the video changes, record the video again and repeat step 6.
- Merge `main` into the branch daily. Git's rename detection carries `main`'s edits
  through moved files. GitHub's conflict check does not, so push the merge.

### 8. Hand off

- Mark the PR ready: `gh pr ready <pr>`.
- Report the PR URL, the preview origin, the test commands and their results, and anything
  still unverified.
- Merge only when the user says so (`AGENTS.md` → "Default delivery", rule 5). After a merge,
  follow **Deploy Dev** to completion.
- Remove the `preview` label when the environment is no longer needed. Closing the PR does
  not tear it down.

## Labels

| Label | Effect | Who can add it |
| --- | --- | --- |
| `preview` | Builds and deploys one full self-host environment for the branch, then runs `pnpm test -- --target-full` against it. Also runs the six-lane `Tests` suite (`tests.yml`). A push redeploys the environment. Removing the label tears it down. | Needs write access, and a PR from a branch of this repo (not a fork). |
| `test` | Runs the six-lane `Tests` suite (`core`, `browser-1`…`4`, `packages`, ~8 min) on the PR. Adding the label re-triggers the suite without a push. | Triage access. |
| `i18n-reorder` | Lets `i18n-catalogs.yml` accept an intentional key reorder in `apps/web/translations/*.json`. | Triage access. |

With no labels, a PR into `main` runs `ci.yml` and the security, compliance, and migration
checks, and the `Tests` check shows as skipped. A PR into `staging` always runs `Tests`. A
PR into `prod` runs `tests-release.yml`. Its `full suite + quality gates` check is the only
required check in the repo.

```bash
gh pr edit <pr> --add-label preview      # or: test
gh pr edit <pr> --remove-label preview   # tears the environment down
```
