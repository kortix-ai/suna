---
recorded: 2026-09-18T18:40:27Z
incident_date: 2026-09-18
commit: 697f157ef6
---
# Preserve the session-bearing project during repository consolidation

**Rule:** Before archiving a project during a repository cutover, count its
sessions and dependent resources. Keep the project ID that owns the historical
sessions as the canonical project. Copy Git refs before moving session rows,
then verify session, connector, transcript, and sandbox reads through the
canonical API. **Near-miss:** a project with over 16,000 historical sessions was
archived while a new project with four sessions remained active; restoration
required a guarded production transfer. **Enforcer:** none; a cutover preflight
that reports project and session counts remains to be built.
