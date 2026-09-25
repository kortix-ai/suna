---
name: commit-dis
description: "Stage and commit ONLY the work done in this session, on the CURRENT branch — no new branch, no PR, no push. Load whenever the user says 'commit this', 'commit-dis', 'git add commit what we did', 'commit dis', 'save my work', or otherwise asks to commit the changes from the current thread. Enforces: stay on the already-checked-out branch, never overcommit unrelated files."
---

# commit-dis — commit this session's work, here, now

Stage and commit the changes produced during **this conversation** onto the
**current branch**. Nothing more. This is the quick "save what we just did"
button.

## THE RULES

1. **Stay on the current branch.** Do NOT create, switch, or rename a branch.
   Commit wherever `HEAD` already points — even if that's `main`. Never run
   `git checkout -b`, `git switch -c`, or `git branch`.
2. **Only commit what this session changed.** Stage the specific files you
   created or edited in this thread by path. Do NOT `git add -A` / `git add .`
   blindly — that risks sweeping in unrelated working-tree changes, untracked
   scratch files, or another task's edits. No overcommitting.
3. **No push, no PR.** Stop after the commit unless the user explicitly asks
   to push or open a PR.
4. **One commit** for the session's work unless the user asks otherwise.

## Steps

1. Confirm the branch and see what's changed:
   ```bash
   git rev-parse --abbrev-ref HEAD
   git status --short
   ```
2. Identify the exact files **this session** touched. If anything in
   `git status` was NOT changed by this session, leave it unstaged. If it's
   ambiguous whether a dirty file belongs to this session, ask the user rather
   than guessing.
3. Stage by explicit path (never `-A`/`.`):
   ```bash
   git add <file1> <file2> ...
   ```
4. Commit with a clear message describing what this session did. End the
   message with the standard trailer:
   ```
   Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
   ```
5. Confirm:
   ```bash
   git log --oneline -1
   ```

## Don't

- Don't create or switch branches.
- Don't `git add -A`, `git add .`, or `git commit -a`.
- Don't push or open a PR.
- Don't amend or rebase prior commits.
- Don't stage files you didn't touch this session (build artifacts, other
  in-flight work, untracked scratch).
