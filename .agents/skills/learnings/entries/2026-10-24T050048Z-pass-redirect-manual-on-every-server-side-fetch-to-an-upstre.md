---
recorded: 2026-10-24T05:00:48Z
incident_date: 2026-10-24
---
# Pass redirect: 'manual' on every server-side fetch to an upstream a user controls

**Rule:** A `fetch` from the API to a server a user writes (an App machine, a sandbox port, a customer URL) passes `redirect: 'manual'` and treats a 3xx as a failed answer. The default `follow` re-sends the request, its credential headers and its body to any host the 3xx names.

**Trigger surface:** Adding or changing any API call through an App or sandbox ingress (`hosting.ingress`, `ingressTargetUrl`), a webhook-style outbound call, or any call whose answer a project member's code controls.

**Incident:** Near-miss, PR #10876 (2026-10-24). The new App-target call (`apps/api/src/apps/app-call.ts`) followed redirects: an App answering `307` made the API re-issue the POST with the private-ingress token to an internal host, and the status came back through the trigger's `last_error`. A security review bot caught it before merge; nothing shipped.

**Enforcement:** `apps/api/src/apps/app-call.test.ts` (a 307 to a second local server must fail the call and reach nothing). None yet across the API: a lint rule that flags a `fetch` whose URL comes from `ingressTargetUrl` without `redirect: 'manual'`.
