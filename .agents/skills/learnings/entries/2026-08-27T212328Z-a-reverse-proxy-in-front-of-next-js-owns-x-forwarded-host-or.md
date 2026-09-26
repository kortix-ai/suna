---
recorded: 2026-08-27T21:23:28Z
incident_date: 2026-08-27
commit: 84c265639f
---
# A reverse proxy in front of Next.js owns `x-forwarded-host`, or every Server Action dies

**When:** putting any proxy/ingress in front of a Next.js app — a preview edge,
a sandbox ingress, a tunnel. Next's Server Action CSRF guard compares
`x-forwarded-host` against `origin` and aborts when they differ:
`Invalid Server Actions request`, HTTP 500, surfaced in the browser only as
**minified React error #441**. It kills EVERY Server Action, not just the one
in front of you — on the preview stack that meant nobody could sign in at all,
because the whole auth flow is Server Actions.

The mismatch is easy to create and invisible from the client: the sandbox
ingress set `x-forwarded-host` to the INTERNAL host (`*.aec.local`) while the
browser's `origin` was the public `*.sbx.platinum.dev`. Nothing in the app is
wrong, and no application log says so — the error text lives in the **Next
server's** own stdout, reachable only from the container
(`docker logs <frontend>`), never from the response, which carries an opaque
`digest`.

**Rules.** (1) A proxy that terminates the public hostname must pin
`X-Forwarded-Host` (and `X-Forwarded-Proto`) to the PUBLIC host on the Next
upstream — the API/Supabase/static handles neither need it nor should get it.
(2) A minified React error with no stack is a SERVER error: read the server's
own log before reading any client code. (3) `digest` is a hash, not a message —
grep the container for it.

*Incident:* every `preview`-labelled PR was impossible to sign into; the whole
environment read as "the app is broken". Fixed by pinning the host in
`buildPreviewCaddyfile`.
*Enforcer:* `tests/unit/preview-stack.test.ts` — "pins the PUBLIC host on the
Next upstream for Server Actions".
