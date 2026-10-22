---
recorded: 2026-10-06T15:57:54Z
incident_date: 2026-10-06
---
# Give every provider cooldown a short re-try; never trust a reset hint for days

**Rule:** When the gateway rests a stored provider account after a limit
(`coolDownAccountSecret`), it must also schedule a re-try within minutes
(`cooldown_probe_at`, 15 min). A provider's reset hint ("resets in 4 days") is
a ceiling, not a fact: the user can reset usage early. An owner must also be
able to end a rest by hand (`POST …/secret-resources/:secretId/retry`,
`kortix providers retry`).

**Trigger surface:** writing or changing `cooldown_until` handling in
`apps/api/src/secrets/account-resource.ts`, the gateway's 429 handling in
`packages/llm-gateway`, or any new provider pool that rests credentials.

**Incident:** 2026-10-06. A project's ChatGPT connection hit its weekly plan
limit and rested for the hinted 4 days. The owner reset ChatGPT usage, but
nothing re-tried the connection, so every request fell back to the paid
`glm-5.3-flash` route (about $790/day of gateway spend) until someone
reconnected the account. Fixed in #9257 (`7c51a3f343`): the first resolve after
the probe time lifts the rest once across replicas; a still-limited provider
rests it again on its next 429.

**Enforcement:** `apps/api/src/__tests__/integration-usable-gateway-secrets.test.ts`
("15 minutes after a usage limit, the next resolve lifts the rest once; another
limit rests it again" and "clearing a cooldown makes the account usable at
once") and the `SEC-POOL-1` REST flow step for the retry route.
