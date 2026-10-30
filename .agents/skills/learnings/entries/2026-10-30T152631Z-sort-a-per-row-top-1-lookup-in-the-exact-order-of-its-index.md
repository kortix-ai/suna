---
recorded: 2026-10-30T15:26:31Z
incident_date: 2026-10-30
---
# Sort a per-row top-1 lookup in the exact order of its index, including NULLS FIRST or LAST

**Rule:** When a query runs `ORDER BY … LIMIT 1` once per row (a LATERAL join or
a correlated subquery), write the ORDER BY in the exact order of the index it
seeks, NULLS clause included. An index built `DESC NULLS LAST` does not serve a
plain `DESC`, which means NULLS FIRST, even on a NOT NULL column. PostgreSQL
then reads every matching row and sorts it, once per outer row.

**Trigger surface:** Writing or reviewing a LATERAL / correlated top-1 lookup,
or adding an index with a NULLS clause that such a lookup uses.

**Incident:** 2026-10-30, production (PostgreSQL 15). `GET /v1/projects/:id/sessions/:sid/model-usage`
mapped each gateway request to its turn with `order by started_at desc` against
`(session_id, started_at DESC NULLS LAST)`. A session with 13,316 requests and
1,377 turns took 7.8 s per read, with 8.8 M buffer hits. In 24 h, 176 reads failed with
500/503 at the 25 s limit. One open session spent 5.6 h of request time. With
`desc nulls last`: 108 ms and 65 k buffer hits, the same result for all 13,316
requests. Fixed in PR #11219.

**Enforcement:** `apps/api/src/__tests__/integration-session-model-usage.test.ts`,
"a long session reads one turn per request, not every earlier turn". It uses
4,000 turns, 8,000 requests and a 500 ms statement timeout. It fails with
SQLSTATE 57014 on plain `desc`.
