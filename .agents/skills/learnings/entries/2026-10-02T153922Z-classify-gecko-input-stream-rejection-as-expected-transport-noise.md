---
recorded: 2026-10-02T15:39:22Z
incident_date: 2026-10-02
supersedes: 2026-10-02T054347Z-keep-attributable-input-stream-failures-reportable.md
---
# Classify the Gecko input-stream rejection as expected transport noise

**Rule:** `TypeError: Error in input stream` with the frameless global unhandled-rejection shape is the browser's own interrupted-stream-body error, not a first-party failure. Classify it as expected transport noise at the frame-aware Sentry gate; every deviation (a resolvable frame, a near-miss message, another mechanism, a handled capture) keeps reporting.

**Trigger surface:** Changing browser network-noise rules or the Sentry `beforeSend` gate, or triaging a Better Stack frontend error whose message is exactly `Error in input stream`.

**Incident:** 2026-10-02, KRTX-984. The first pass suppressed the signature on "frameless ⇒ noise" and independent review rejected it: framelessness alone proves nothing. The expected-state signal came from evidence gathered afterwards: (1) Gecko throws this exact string from `InputToReadableStreamAlgorithms::ErrorPropagation` (`dom/streams/UnderlyingSourceCallbackHelpers.cpp` in gecko-dev) when the input stream backing a fetch body fails mid-read — a browser-generated message, frameless by construction; (2) both prod occurrences (Firefox 140/Windows) fire at the moment a sandbox-proxied connection was torn down and re-established — 5 ms after a `message?limit=50` 200 and 0.3 s after a `kortix/health` 503 on a box that had 503'd for hours; (3) a local Firefox repro showed the message identifies interrupted SSE-shaped stream reads specifically, while sibling failure modes produce different messages (`Content-Length … exceeds response Body`, `AbortError`); (4) web-wide reports (graphql-sse#99, chatbot-ui#1170, gpt-researcher#288) show the same Firefox-only unhandled rejection; and (5) every first-party fetch-body reader in the bundle handles its own rejections (event-stream machine, session-sync controller, health probe, `makeRequest`, file/attachment readers, vendor SSE generator), so the escaping rejection is the browser-internal pipe promise no app handler can attach to.

**Enforcement:** `apps/web/src/lib/browser-noise/rules/network.ts` (`isGeckoInputStreamRejectionNoise`) anchors on the exact message + the global unhandled-rejection mechanism + no resolvable frame, with the first-party negative guard. `apps/web/src/lib/browser-error-noise.test.mts` and the golden fixture pin the verdict and every deviation.
