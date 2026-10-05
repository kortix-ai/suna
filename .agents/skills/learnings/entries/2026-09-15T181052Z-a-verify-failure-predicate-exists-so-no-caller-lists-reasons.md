---
recorded: 2026-09-15T18:10:52Z
incident_date: 2026-09-15
commit: 6c2966a00a
---
# A verify-failure predicate exists so NO caller lists reasons by hand — grep every caller when you fix one

**When:** adding or fixing any caller of `verifySupabaseJwt` (or any verifier
that returns a reason string). #6698 (2026-08-21) taught both auth middlewares
that `unsupported-alg:HS256` is inconclusive via `isInconclusiveVerifyFailure`,
but `sandbox-proxy/preview-auth.ts` kept `reason !== 'no-keys' && reason !==
'no-key-for-kid'`. Prod JWKS publishes an ES256 key while GoTrue still signs
HS256, so every preview ORIGIN (and `?token=` WebSocket) answered "Sign in to
open this preview" to a valid session while `/v1/p/...` served the same token.
*Incident:* prod, every JWT-authenticated preview origin, v0.13.16 and earlier.
*Enforcer:* tripwire in `unit-jwt-alg-fallback.test.ts` fails when a
production caller skips the predicate or compares a reason literal.
