---
recorded: 2026-09-16T16:51:46Z
incident_date: 2026-09-16
commit: 7c98317cfe
---
# A shared admission budget must charge what a request COSTS, and strict FIFO turns one mis-charged waiter into a fleet-wide outage

**When:** writing or reviewing any admission/quota gate that reserves a
resource before doing work — a memory budget, a connection semaphore, a rate
limiter. Three defects, one incident, each sufficient alone:

1. **`Number(req.headers.get('content-length'))` is `0` when the header is
   absent, and `0` fails a `> 0` test.** Platinum's `budgetBytesFor` then fell
   through to its fallback — `MAX_REQUEST_BODY_BYTES`, 128 MiB — so every body
   with no declared length reserved the entire transport cap. Against a 1.25 GiB
   pool that is TEN concurrent requests for the whole fleet.
2. **Admission was strict FIFO** (`if (!waiters.length && inUse + want <= BUDGET)`),
   so once one waiter existed a 32-byte request queued behind it regardless of
   size. The mis-charge did not slow large uploads; it stopped everything.
3. **A timed-out waiter spliced itself out and rejected without calling
   `drain()`**, so the queue stayed stranded after the wait expired.

GET and HEAD skip the budget by construction, which is exactly the shape prod
showed and the fastest way to recognise this class: **same sandbox, same
second, `GET /global/health` 200 in 0.84 s and `POST /file/mkdir` with a
32-byte body 503 after 50.7 s — and the same route with NO body 400 in 0.83 s.**
The only variable is whether a request body exists. That one probe rules out
auth, connectors, token minting and agent resolution in three curls.

*Incident:* prod 2026-09-15 18:00Z onward. Every POST to a Platinum sandbox
failed while GETs served normally, so no prompt could reach the daemon: 9-13
sessions/hour, ~48 queued prompts/hour dead-lettered, a paying customer
mailing support "not getting any responses back". Defect (1) shipped in
platinum#1007 at 20:42Z; defect (3) survived the first fix and caused a second
episode at 08:00-09:59Z the next morning (37 undelivered, 12 dead-lettered)
until platinum#5e8d99bc.

*Enforcers:* platinum `bodyBudget.test.ts` — an undeclared body pre-charges a
slice not the cap, `settle` returns the over-reservation and drains the waiters
it unblocks, and 64 concurrent undeclared proxy bodies are admitted with 0
refusals. Kortix-side, `deliver.test.ts` pins that a ready-stage runtime whose
POSTs keep failing classifies `unreachable`, not `pending`.
