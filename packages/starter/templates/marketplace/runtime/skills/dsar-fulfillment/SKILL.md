---
name: dsar-fulfillment
description: Daily GDPR data-subject-access-request runbook. Verifies each incoming request from Gmail, locates the subject's data read-only across every relevant Postgres table, compiles an access-or-deletion report in Google Docs within the {{sla_days}}-day SLA, and flags it to {{legal_review_channel}} for a lawyer to approve. Never deletes data and never replies to the subject.
---

<skill name="dsar-fulfillment">

<overview>
Turn a GDPR data subject access or deletion request into a verified, complete
report before the statutory clock runs out, without ever taking the action the
request asks for. A daily cron re-prompts a fresh session: it checks Gmail for
new or unactioned DSARs, verifies each requester's identity, queries Postgres
read-only for every table keyed to that subject, compiles the findings as a
Google Doc, and flags the doc plus a recommended action to legal. Deletion and
the reply to the requester are always a human decision, made after this skill's
work is done.

Reactive to the inbox, schedule-driven, and strictly compile-and-flag — nothing
this skill does is reversible-risk, because it never writes to the subject's
actual data.
</overview>

<when-to-load>
- The daily cron fires the DSAR sweep.
- A human asks the agent to check for or process a data subject request.
- A prior flagged request needs its report re-verified or re-compiled.
</when-to-load>

<workflow>

## Step 1 — Scan the inbox for DSARs

Search Gmail for new or unhandled data subject requests:

- Look for messages that reference access, deletion, erasure, "my data," or
  GDPR/data-subject rights, in the legal/privacy inbox.
- Skip any thread already labeled as actioned by this agent (e.g.
  `dsar-compiled` or `dsar-flagged`) — a fresh session must not reprocess a
  request that's already sitting with legal.
- For each new thread, capture: requester name and email, what's being
  requested (access, deletion, or both), any identity details supplied, and
  the date the request arrived.

## Step 2 — Verify the requester

Before touching any product data:

- Match the requester's email and any supplied identity details (full name,
  account email, order or account ID) against the account records we hold.
- Treat a request as **verified** only when the identifying details line up
  with a single, unambiguous account.
- If the match is weak, ambiguous, or the request supplies no verifiable
  detail, do not proceed to Step 3. Compile a short note explaining what's
  missing and flag it to {{legal_review_channel}} as **unverified** — legal (or
  a follow-up request) decides how to proceed.
- Record the verification date — it starts the SLA clock.

## Step 3 — Locate the subject's data (read-only)

For a verified request, query Postgres read-only across every table that can
be keyed to the subject, for example:

```sql
-- adapt table/column names to the actual schema
select * from users where id = :subject_id;
select * from orders where user_id = :subject_id;
select * from invoices where user_id = :subject_id;
select * from support_tickets where user_id = :subject_id;
select * from consent_records where user_id = :subject_id;
select * from login_history where user_id = :subject_id;
```

- Follow foreign keys outward until every table that stores something
  identifiable to this person has been checked — a partial search is not
  acceptable.
- Never issue anything but a read query. There is no delete or update path in
  this workflow, regardless of what the request asks for.
- If a table can't be reached or a query fails, note it explicitly in the
  report rather than silently omitting that source.

## Step 4 — Compile the report

Create a new Google Doc (one per request), formatted as:

1. **Header** — requester name/email, request type (access / deletion /
   both), date received, date verified, SLA deadline (verified date +
   {{sla_days}} days).
2. **Data inventory** — one section per system/table, listing what was found
   verbatim or summarized (large tables like login history can be
   summarized with counts and date ranges instead of every row).
3. **Recommended action** — fulfill the access request as compiled, or
   proceed with deletion across the listed tables, with any caveats (e.g.
   records legal must retain for a legal-hold or billing-compliance reason).
4. **Verification notes** — how identity was confirmed.

## Step 5 — Flag to legal and label the thread

- Post the Doc link, the requester's name, the request type, the SLA
  deadline, and the recommended action to {{legal_review_channel}}.
- Label the Gmail thread as actioned (`dsar-compiled`, or `dsar-flagged` if
  verification failed) so the next day's sweep doesn't reprocess it.
- Stop here. Do not reply to the requester, do not run any deletion, and do
  not mark the request as resolved — that's legal's call.

</workflow>

<guardrails>
- **Read-only on subject data.** Every Postgres query in this workflow is a
  `SELECT`. No delete, no update, no matter what the request asks for.
- **Verify before you locate.** Never query for a subject's data on a request
  that hasn't passed identity verification.
- **Compile, don't decide.** The report always ends in a *recommended* action,
  never an executed one.
- **Never contact the requester.** The only outbound message this skill
  produces is the flag to {{legal_review_channel}}. The reply to the subject is
  written and sent by legal.
- **Deletion is never automatic.** Even an explicit erasure request only
  results in a recommendation in the doc. A lawyer approves it and someone
  else executes it, outside this workflow.
- **SLA is stated, not enforced by silence.** Every flag states the deadline
  explicitly, and calls out requests that are close to breaching it.
- **Secrets scoped.** Gmail, Postgres, and Google Docs credentials are
  injected at runtime by the connector, never written to disk or logged.
</guardrails>

</skill>
