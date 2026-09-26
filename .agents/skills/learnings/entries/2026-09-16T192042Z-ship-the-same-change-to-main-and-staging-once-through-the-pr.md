---
recorded: 2026-09-16T19:20:42Z
incident_date: 2026-09-16
commit: 15fa494528
---
# Ship the same change to `main` and `staging` ONCE, through the promote — never twice

**When:** a fix is wanted on staging before the next promote. Land it on `main`,
then promote. A second PR that re-implements it against `staging` gives git two
unrelated edits to the same lines, and the next `main -> staging` PR goes DIRTY.
*Incident:* "the project session list is a keyset page" shipped as #7308 (main,
`6f52904b61`) AND #7314 (staging, `a5290753fa`). Promote #7292 blocked on a
4-file conflict for hours. Worse, the two were NOT equivalent: #7314 also
pinned the session cursor's GCM nonce and auth-tag lengths, so `main` ran for a
day accepting a client-supplied 4-byte auth tag — ~2^32 to forge a cursor
instead of ~2^128. Resolving such a conflict by `--ours`/`--theirs` reflex
silently picks one; diff the two sides and take the superset.
*Enforcer:* none for the duplicate itself — the conflict IS the signal. Read it
as "two branches disagree", never as "git being annoying".
