---
recorded: 2026-09-26T15:56:17Z
incident_date: 2026-08-28
---
# Verification output is an exfiltration surface — allowlist fields before printing

**Rule:** treat diagnostic/verification command output as an outbound data
boundary. Never print a complete credential-bearing config, request record,
cookie, callback URL, or process environment. Select an explicit allowlist of
safe scalar fields inside the command itself. For URLs, emit
`new URL(value).origin` or strip `/`, `?`, AND `#` suffixes — a filter that
only stops at `/` or `?` leaves an OAuth fragment token intact. For browser
network proof, emit only method, sanitized URL, status, and resource type.
Capture secrets inside one process and print only the final assertion. A
redaction that depends on key depth (top-level only) or an incomplete
delimiter set is not a redaction.

**Trigger surface:** any manual dev-verification pass that reads live config,
runs a browser network capture, or prints a request/response for evidence.

**Incident:** PR #7029 dev verification (2026-08-28): three read-only
verification commands printed live credentials to the tool transcript — a
`jq` filter that redacted only top-level keys left nested CLI host tokens
intact, an `agent-browser network requests --json` call printed the
`Authorization` header verbatim, and a URL-origin filter that stopped at `/`
and `?` left an OAuth fragment token in place. The temporary browser session
was revoked and both browser profiles were cleared; the printed values still
persisted in the tool transcript until it expired.

**Enforcement:** none automated. Candidate: a repository wrapper that
normalizes browser-network and configuration evidence to the safe allowlist,
tested with nested tokens, `Authorization` headers, and fragment tokens.
