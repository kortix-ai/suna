---
recorded: 2026-10-28T21:27:41Z
incident_date: 2026-10-28
---
# A 409 from Files is not proof of another writer while a session runs: read the file before you show a conflict

**Rule:** A client that writes a Files path while a session may run must treat `409 version_conflict` / If-Match `412` as "read the file", not "someone else wrote": take a new version with the same text, and space its own writes ≥ 1.5 s apart. Never chain a follow-up write right after the previous one lands.

**Trigger surface:** Any editor, CLI command or agent tool that saves a file in a project's Files volume repeatedly (artifact docs, memory pages, drive uploads) with `base_version` / If-Match.

**Incident:** 2026-10-28. On dev, the artifact doc editor showed "Someone saved a newer version" (3 toasts) to a lone editor, then stayed on "Not saved". Two causes: overlapping autosaves on one base, and a running session's Files mount that merges `index.md` back 1–3 s after every API write. The merge gives the file a new version, and when 2 writes land < 700 ms apart it brings back the older text (2 of 4 writes lost at 0–300 ms, 0 of 4 at ≥ 700 ms; 0 of 4 with the session stopped). Fixed in the editor by suna #11056; the storage cause is kortix-ai/platinum#2145.

**Enforcement:** `apps/web/src/features/artifacts/doc-autosave.test.ts` (queue, ≥ `SAVE_GAP_MS` spacing, same-text churn, older-text revert, conflict). Other writers: none yet, until platinum#2145 lands.
