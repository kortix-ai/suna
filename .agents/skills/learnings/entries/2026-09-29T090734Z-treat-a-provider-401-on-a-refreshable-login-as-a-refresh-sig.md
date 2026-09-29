---
recorded: 2026-09-29T09:07:34Z
incident_date: 2026-09-29
---
# Treat a provider 401 on a refreshable login as a refresh signal, never as final

**Rule:** A stored OAuth login's expiry is a hint, not the truth. When the provider answers `401` for a refreshable login (`refreshableCredential` on the descriptor), force one refresh and retry once (`refreshCredential` hook in `packages/llm-gateway/src/pipeline/dispatch.ts`). A refused refresh marks the login `needs_reauth_at`, and the next pool member takes the request. Never write a synthetic or test login over a real account's stored credential on a shared environment: nothing audits it, and every session that selects that account breaks.

**Trigger surface:** Adding a provider whose credential can be renewed, changing how the gateway reacts to upstream statuses, or seeding test credentials on dev, staging, or a preview.

**Incident:** 2026-09-28 13:47Z to 2026-09-29. A shared ChatGPT account on dev had its stored login replaced by a synthetic token (3 claims, 278 characters) with no audit event. ChatGPT refused it: `401 Could not parse your authentication token`, code `unauthorized_unknown`. The stored expiry was weeks away, so the gateway never refreshed it, never marked it, and passed the raw 401 on. Every Teams turn on that account failed, and the card told the user to ask an admin about an API key.

**Enforcement:** `packages/llm-gateway/src/pipeline/dispatch.test.ts` ("dispatch: a refused login"), `apps/api/src/llm-gateway/credentials/codex-consumer.test.ts` (`refreshRefusedCodexAccountLogin`), `apps/api/src/llm-gateway/internal-routes.test.ts` (`POST /refresh-credential`), `apps/api/src/__tests__/unit-slack-error-classify.test.ts` (ChatGPT login copy). None yet for the write side: an audit event on every account-secret value write.
