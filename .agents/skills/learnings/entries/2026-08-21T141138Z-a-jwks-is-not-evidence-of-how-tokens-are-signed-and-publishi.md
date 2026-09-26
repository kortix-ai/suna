---
recorded: 2026-08-21T14:11:38Z
incident_date: 2026-08-21
commit: 22a2298abd
---
# A JWKS is not evidence of how tokens are signed, and publishing a key changes behavior before you promote it

**When:** migrating a Supabase project to asymmetric JWT signing keys, or
reasoning about which algorithm any environment actually uses.

Two traps, both hit in one session.

**1. Read the token, never the JWKS.** Dev's `/.well-known/jwks.json` advertised
`ES256` and had since 2025-11-30 — while every token it issued was `HS256`. The
key existed in `standby` and had never been promoted. A whole perf change was
reported as "dev gets the win" on that basis and it was wrong. The only
authoritative check is decoding a real access token header:
`base64url(token.split('.')[0])` -> `{"alg":...,"kid":...}`.

**2. Importing the legacy secret publishes an asymmetric key immediately.**
`POST /config/auth/signing-keys/legacy` looks inert — it only registers the
existing HS256 secret as a key — but it also surfaces a standby ES256 key in
JWKS. That flips every verifier from "JWKS is empty, fall back to the network"
to "I have keys, verify locally", **without anything being promoted**, and it
cannot be undone: a `standby` key may only move to `in_use` or
`previously_used`, so the JWKS cannot be emptied again.

That mattered because `apps/api/src/shared/jwt-verify.ts` implements ES256/RS256
only, selects a key by `kid` and falls through to *first key in the cache* when a
token carries none, and `middleware/auth.ts` treated `unsupported-alg` as a hard
401 rather than an inconclusive result. A legacy token with no `kid` would have
selected the new ES256 key and 401'd on a valid session. It was unreachable only
because GoTrue stamps a `kid` on every token, including projects with an empty
JWKS (verified: `{"alg":"HS256","kid":"IBZFPqpuE0oC+hnZ"}`). Fixed in PR #6698 —
check the algorithm before selecting a key, and route both middlewares through
one `isInconclusiveVerifyFailure` predicate.

**The rules:** (1) verify an environment's signing algorithm from a minted token,
never from JWKS or a docstring; (2) before publishing a key anywhere, read every
verifier that consumes that JWKS and confirm an unknown/foreign algorithm falls
back instead of rejecting; (3) treat the legacy import as a behavior change, not
bookkeeping — it is one-way.

*Near-miss:* no outage. Prod was staged (ES256 `standby`, HS256 `in_use`) and its
tokens never changed. Dev and staging were promoted and verified: pre-rotation
sessions kept returning 200 (the old key moves to `previously_used` and still
verifies) and `service_role`/`anon` keys were unaffected.
*Enforcer:* `apps/api/src/__tests__/unit-jwt-alg-fallback.test.ts` pins the
predicate and the no-`kid` symmetric case. Nothing enforces rule (1) — prose only.
