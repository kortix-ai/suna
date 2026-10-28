---
recorded: 2026-10-28T13:08:12Z
incident_date: 2026-10-28
---
# Run a multi-step git script against a scratch clone as a bash file with cd || exit and a toplevel check, never as an inline zsh chain

**Rule:** A script that clones a repository into a scratch folder and then edits, commits or pushes there runs as a `bash` file, not as an inline command in the agent shell. It does `cd "$CLONE" || exit 1`, then refuses to continue unless `git rev-parse --show-toplevel` is the clone and `git remote get-url origin` is the expected origin. Never rely on `set -e` inside a `( … )` subshell of the agent shell.

**Trigger surface:** Driving a test project's git repository from an agent session: seeding a manifest, pushing a fixture branch, reproducing a change request. The agent shell is zsh and resets its working directory to the primary checkout after every call.

**Incident:** 2026-10-28, PR #10931 local verification. The scratch clone failed on authentication (the git proxy wants a Kortix token, not a Supabase JWT). The inline `( set -euo pipefail; … cd "$CLONE"; … )` kept going after the failed `cd`, so `git rm -r .`, the fixture write and `git commit` ran in the primary checkout, and `git push origin HEAD:main` targeted the GitHub origin. GitHub refused the credentials, so nothing left the machine. The primary checkout was reset to its previous commit; an empty untracked `memory/` directory was recreated.

**Enforcement:** none yet: a guard in the agent shell that refuses `git push` from the primary checkout to any ref other than a branch the user named.
