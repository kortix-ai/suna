---
recorded: 2026-08-20T21:56:09Z
commit: 12d9f8abd3
---
# A browser must never be handed a 5xx for an expected state — an intermediary will replace it

Found 2026-08-20 while shipping per-port preview origins (PR #6681 + follow-ups).
A preview URL whose app had not yet bound its port returned Cloudflare's branded
"Error 502 Bad gateway" page after ~12s. The API was innocent of the *page*: it
had carefully built a friendly "port isn't responding" HTML body — and returned
it with status **502**, so Cloudflare discarded body and all and substituted its
own interstitial.

**The tell:** our `x-kortix-proxy-hop` header was absent from what reached the
client. A response of yours that arrives without a header you always set was not
passed through — it was swapped. Check for one of your own headers before
believing the status you see came from your code.

**The error was semantic, not numeric.** "The dev server has not bound the port
yet" and "the box is waking" are the ordinary first seconds of a preview, not
gateway failures. A 5xx is an invitation every proxy in the chain accepts.

**Rules.**
1. For a top-level browser navigation, an expected/transient state answers **200
   with a page that explains itself and retries**. Reserve 5xx for genuine
   failure. Identity states (401/403/404) are safe — intermediaries pass those
   through, and a monitor should see them.
2. Keep the truth machine-readable: non-navigation requests keep the accurate
   status, and the state travels in a header (`x-kortix-preview-state`) set on
   the HTML too, so probes lose nothing.
3. Decide by `Sec-Fetch-Dest`, not by status — an app's own `fetch('/api')` must
   never receive HTML.

**Corollary paid for in the same session — a mock that weakens a production
constant asserts an unreachable branch.** A file-share test mocked
`PUBLIC_SHARE_BLOCKED_PORTS` as EMPTY. The real constant contains the
static-file port, so the shipped code refused the very case the test "proved"
worked. When mocking a module for its collaborators, carry its CONSTANTS
verbatim; a constant is the production behaviour, not a fixture.

*Incident:* no outage — dev only, reported by the product owner and fixed the
same session. Both the path proxy and the new origin were affected, so the 502
had been reachable long before preview origins existed.
