---
recorded: 2026-08-13T07:54:28Z
incident_date: 2026-08-12
commit: 300191e772
---
# Anything created per-deploy needs a reaper, and the reaper needs a namespace

**When:** adding or reviewing code that creates a named provider-side artifact
— a snapshot, image, template, volume. Ask two questions: *what deletes the
previous one*, and *whose is it*. `ensureMetaSandboxImage` answered neither: it
deleted a snapshot only when its OWN build failed, never when a newer one
superseded it, and its name carried no environment. The meta fingerprint hashes
the agent/CLI/SDK/shared/starter source trees, so it moves on nearly every
commit — one permanent snapshot per deploy, forever.
Namespace the name by `INTERNAL_KORTIX_ENV`: dev, staging and prod share ONE
Daytona organisation (same API key in all four env profiles), so an
un-namespaced reap on dev deletes the image prod boots from. And make the
"is it still in use" lookup fail **closed** — `recentlyBuiltSnapshotNames`
returns an empty set on a DB error, which a reaper reads as "nothing is
protected, delete everything".
Before writing any reaper, find who still reads the thing: the sibling
`kortix-app-*` snapshots look equally abandoned but are the targets of
`POST /apps/{appId}/rollback`, so reaping them on supersession would have
broken rollback. Unbounded-but-needed means bounded retention, not deletion.
*Incident:* the Daytona organisation hit its 200-snapshot quota (226, of which
118 meta at ~8/day). `POST /snapshots` then 400s, which fails every CI run and
every NEW-project build. Existing projects survived only because
`canServeLastKnownGoodRuntime` lets a session-start boot the previous image —
so the visible symptom was "CI is broken", while the quieter one was that
runtime updates silently stopped reaching sandboxes.
