---
recorded: 2026-09-10T21:31:38Z
incident_date: 2026-09-10
commit: b068d62921
---
# A wrapper error hides its cause — walk the chain, never read `.message`

**When:** branching on an error's identity anywhere near an ORM. A Drizzle
failure's `message` is only `Failed query: <sql>\nparams: <values>`; the
SQLSTATE, constraint name and detail all hang off `cause`. Every
`err.message.includes('…')` guard near a database call is already broken.
*Incidents, all three the same defect:* (1) the credits reset suppressed
duplicates with `msg.includes('duplicate key')` — never matched, so a correctly
refused re-grant logged an error every nine minutes for four days (1,118 of
them, one account); (2) the audit ingest classified retryability on `code`
alone, so `PostgresError: the database system is shutting down` answered 500 and
dropped the batch — 21,102 exceptions / 244 users, 19,193 on one day; (3)
`app.onError` logged `-> 403 [HTTPException]` with the reason only in structured
context, and Better Stack groups on the message, so 2,338 denials collapsed into
one unactionable bucket. *Fix:* one cause-walking helper per area
(`errorChainText`, `auditErrorSqlstate`) and the reason IN the message.
*Enforcer:* `credit-duplicate-error.test.ts` asserts the naive check would have
missed it; `audit-db.test.ts` pins recognition through the wrapper.
