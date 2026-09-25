---
recorded: 2026-09-10T21:31:38Z
incident_date: 2026-09-10
commit: b068d62921
---
# A 404 is invisible to error alerting — check the 4xx surface for dead integrations

**When:** auditing production health. Error dashboards read error-level logs, so
a correct-looking `404` never appears in them. Sweep the 4xx surface by route
periodically and ask what SHOULD have happened. *Incident:* `POST
/v1/webhooks/user-created` has 404'd on **every new user signup since at least
2026-07-12** — 9 calls for 9 signups on 2026-09-04, 45 for 47 on 2026-09-10,
with ~4x retries on busy days, roughly 3,000 signups in 60 days. No such handler
has ever existed in the repo; `/v1/webhooks/:triggerId` reads `user-created` as
a trigger slug no project defines. Whatever it was meant to trigger has not run
for two months, and nothing alerted because the API answered "correctly".
Same shape: the `pr-review` and `qa-pr-sweep` webhook 404s. *Automation:* none
yet — candidate: a weekly report of the top 4xx routes with no matching route
definition.
