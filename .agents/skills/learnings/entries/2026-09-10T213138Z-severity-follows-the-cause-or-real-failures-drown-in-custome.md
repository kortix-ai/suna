---
recorded: 2026-09-10T21:31:38Z
incident_date: 2026-09-10
commit: b068d62921
---
# Severity follows the CAUSE, or real failures drown in customer state

**When:** an automated retry gives up. `error` means the PLATFORM dropped the
work. An account that is out of credits, a model it is not entitled to, or a
manifest its owner wrote wrong are customer state: the product already says so
where the owner can see it, and paging on it teaches everyone to ignore the
channel. *Incident:* `[session-lifecycle] command dead-lettered` fired 7,761
times in seven days; 3,113 of the last 3,238 (96%) were cron triggers firing
into accounts that cannot pay, one account contributing 2,131. The real signal
— `delivery outcome: pending`, `runtime unreachable` — was a hundred times
rarer than the noise burying it. An unrecognised message must stay `error`;
only a recognised customer-state message is demoted. *Enforcer:*
`dead-letter-cause.test.ts` pins the five real messages verbatim from prod.
