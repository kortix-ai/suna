---
recorded: 2026-09-21T14:39:46Z
incident_date: 2026-09-21
commit: 7c7c6e1e14
---
# A repository replacement must not block an existing session

**Rule:** Load an existing session and its preserved workspace through the ordinary lifecycle after a repository replacement. Keep its stable project Git proxy origin, resolve the current upstream repository and credentials server-side, and show only a compact warning that the workspace started from the previous repository. Never replace the transcript with a repository-generation gate. **Incident:** the first cutover guard made 16,000+ historical sessions inaccessible even though their proxy URL and session branch authority remained valid. **Enforcers:** `SESS-33`, browser journey 31, and Git proxy authorization tests.
