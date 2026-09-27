---
recorded: 2026-08-24T08:20:44Z
incident_date: 2026-08-24
commit: 8ea438c660
---
# Provider traffic credentials need a cross-replica refresh bound

**When:** caching a provider handle that carries a private ingress token. Bound
the cache lifetime and refresh it with single-flight connection work. A resume
can rotate the token in one API replica while every other replica retains the
old handle indefinitely. *Incident:* an SampleCo E2B guest was locally ready in
12.9 seconds, but `/start` failed because another API replica used its stale
traffic token and received repeated `502 port not ready` responses.
*Enforcer:* E2B ingress rotation and concurrent-refresh tests.
