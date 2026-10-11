---
recorded: 2026-10-06T16:09:00Z
incident_date: 2026-10-06
---
# Make every keep-alive poll report a stop, never undo it: a poll that can wake a box defeats Stop and idle reaping

**Rule:** Send every recurring `/start` revalidation with `?keep_stopped=1` (`startProjectSession({ keepStopped: true })`). The API then answers `stage: stopped` for a box with `stopReason` `manual` or an idle/deadline reason, and never wakes it. Only an explicit open (no flag) resumes. Pause the poll while the tab is hidden.

**Trigger surface:** Editing `useSession`'s `/start` query, `resumeHibernatedOnOpen`, `/start` route flags, or any new poll that calls an endpoint which can provision or resume compute.

**Incident:** 2026-10-06 audit of the session runtime. The ready-state `/start` poll ran every 60 s in every tab, including background tabs. `resumeHibernatedOnOpen` never read `stopReason`. A user Stop, or an idle reaper stop, was undone within 60 s while any tab stayed open, so a tab left open kept a box and its compute meter running.

**Enforcement:** `apps/api/src/projects/session-open/keep-stopped.test.ts` (which stop reasons a poll may wake), `packages/sdk/src/react/hold-live-start.test.ts` (`liveStartPollMode`), `session-sandbox.test.ts` (`keep_stopped=1` on the wire).
