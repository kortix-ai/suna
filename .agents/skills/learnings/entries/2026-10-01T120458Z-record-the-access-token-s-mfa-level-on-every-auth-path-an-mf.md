---
recorded: 2026-10-01T12:04:58Z
incident_date: 2026-10-01
---
# Record the access token's MFA level on every auth path; an MFA gate behind an auth path that drops it refuses aal2 sessions

**Rule:** Every auth path that accepts a Supabase JWT records its `aal` claim as `mfaAal` (`jwtPrincipal`, `apps/api/src/middleware/auth-principal.ts`). An account that requires MFA is gated on it in two places:
- `mfaGateBlocks` in `iam/authorize.ts`, through `buildActor`;
- `completeChatLogin` in `channels/core/identity.ts`.

An auth path that drops the claim makes a verified aal2 session look aal1. Every gated call is then refused, however often the person passes the step-up dialog. When you add an auth path or a middleware, pin its `mfaAal` in `auth-characterization.test.ts`.

**Trigger surface:**
- `apps/api/src/middleware/auth-principal.ts`, `auth-combined.ts`, `auth.ts`;
- any new middleware that sets `userId` from a JWT;
- any route that adds an MFA gate (`mfaGateBlocks`, `account_mfa_required`);
- the web step-up (`apps/web/src/features/auth/mfa-step-up.tsx`).

**Incident:** 2026-10-01, found in a live Teams test on dev. A member of an account with "Require MFA" opened a Teams sign-in link and clicked Connect. They entered a valid code in "Verify it's you", and Connect asked for the code again on every try. `combinedAuth`'s local verify path set `userId` but never `mfaAal`. That was the case before the 2026-09-28 split into `auth-principal.ts` (#7933), and the split kept the behavior. `/bind` (Slack and Teams) gained its MFA check in #8302 (2026-09-29), behind `combinedAuth`. The same gap refused aal2 sessions of MFA-required accounts on every `combinedAuth` route that calls `authorize`: connectors, tunnel, skills, and the sandbox proxy. The web page now also retries the bind after a verified step-up, without a second click. Fixed in PR #8611.

**Enforcement:** `apps/api/src/middleware/auth-characterization.test.ts` → "<middleware> records the verified token's MFA level", for both `supabaseAuth` and `combinedAuth`.
