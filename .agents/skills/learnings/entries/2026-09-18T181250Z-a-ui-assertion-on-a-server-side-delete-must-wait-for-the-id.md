---
recorded: 2026-09-18T18:12:50Z
incident_date: 2026-09-18
commit: 5866a4be60
---
# A UI assertion on a server-side DELETE must wait for the id to exist, and an element budget must fit the round trips behind it

**When:** writing a browser assertion about an action that identifies a server
row, or putting an explicit `{ timeout: N }` on an element that appears only
after several API round trips. `28-eager-composer-attachments` did both and had
never run green on a deployed target: it was ADDED by #7148 (`8a7945bb61`,
v0.13.21) while the release gate was broken, so its first real execution was
the gate itself — exactly the "added only in the PR that carries its green
deployed run" rule below, paid for again.

Two failures, one cause — local latency written into a deployed assertion:

1. **Remove-before-id.** The composer draws an attachment tile from the local
   `File`, before `POST /attachments` answers with the `attachment_id`. The spec
   clicked Remove the frame the tile appeared, so on staging (begin measured at
   **2.67–6.80 s**) the id did not exist yet and no DELETE was sent. Locally the
   begin is ~20 ms, so the race was invisible. Evidence: trace `POST
   .../attachments` **status -1 after 862 ms** — the client aborted its own
   initiation.
2. **A 10 s budget over a two-round-trip path.** `Retry upload of retry.txt`
   renders only after begin → refused PUT → **re-sign begin** → refused PUT.
   Measured on staging that chain took **10.35 s** against the spec's 10 s
   override. The journey's whole attempt also exceeded the deployed profile's
   120 s default (`complete` alone measured 3.43–10.14 s).

**Rules.** (1) Assert an action that needs a server id only after the state
that produces the id is observable — here `aria-busy` clearing. (2) An explicit
`{ timeout: N }` OVERRIDES the deployed profile's own budget; write one only
when N exceeds it, never below. Prefer inheriting the profile. (3) Reproduce a
deployed-only failure locally by injecting the measured latency into the spec's
own `page.route` before changing anything — 4 s reproduced failure 1, 6 s
reproduced failure 2, both verbatim, at the exact spec lines the gate named.

**Product defect found underneath it.** `remove()` in
`packages/sdk/src/core/attachments/prompt-attachments.ts` aborted the
initiation, which cancels the ONLY answer that names the row the server already
created — so its own documented guard ("an initiation response can race
explicit removal before its handle was known") was unreachable, and each such
removal stranded 1 of the user's **40** pending handles
(`PROMPT_ATTACHMENT_MAX_PENDING_HANDLES`) for 24 h. Attach-then-immediately-
remove on a slow network could therefore 429 a user out of attachments for a
day. Fixed: the abort is deferred until `onUpload` hands over the id, which then
aborts before a byte is sent and deletes the row exactly once.

*Incident:* release-gate runs 35235942169, 35242868705, 35284894537,
35310995962 and 35369184776 — 5 consecutive gates, no production impact.
*Enforcers:* two cases in
`packages/sdk/src/core/attachments/prompt-attachments.test.ts` ("remove during
initiation deletes the row the server already created", and the never-yields-a-
handle case). Nothing yet rejects an element `{ timeout: N }` smaller than the
deployed profile's own budget — that lint is the TODO.
