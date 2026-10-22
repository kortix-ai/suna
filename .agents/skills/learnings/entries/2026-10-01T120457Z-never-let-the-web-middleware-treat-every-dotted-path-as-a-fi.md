---
recorded: 2026-10-01T12:04:57Z
incident_date: 2026-10-01
---
# Never let the web middleware treat every dotted path as a file; a page whose token is payload.signature then 404s

**Rule:** Every web page lives under `app/[locale]`, and only the middleware's rewrite reaches it. A path the middleware skips as a "file" never gets that rewrite, and Next answers 404. The file test is `isFilePath` in `apps/web/src/i18n/routing.ts`: a dot marks a file, except in a page listed there. Before you add a page whose URL segment can hold a dot, add it to that exception and to `middleware-locale-routing.test.ts`. Such a URL is a signed `<payload>.<signature>` token, a JWT, or a dotted slug. Then open the real link, not a hand-typed one.

**Trigger surface:** `apps/web/src/middleware.ts`, `apps/web/src/i18n/routing.ts` (`isNonPagePath`), any new page route with a dynamic segment, and any API code that mints a link to a web page. Examples: the Slack and Teams sign-in links (`channels/*/login.ts`), setup links, and share links.

**Incident:** 2026-10-01, found in a live Teams test on dev. Every Slack and Teams sign-in link (`/slack/login/<token>`, `/teams/login/<token>`, signed by `channels/core/signed-state.ts` as `<body>.<mac>`) answered 404 on dev and on `kortix.com`. It happened because `pathname.includes('.')` skipped the locale rewrite. The cause was #7566 (2026-09-24), which moved every page under `app/[locale]`. Before that, the page did not need the rewrite. Nobody could link a chat account from that release until the fix, PR #8611. Setup links (`ksl_…`) were not affected: their base64url token has no literal dot.

**Enforcement:** `apps/web/src/middleware-locale-routing.test.ts` → "chat sign-in links carry a dotted token":
- an anonymous visitor with a dotted token gets the 307 to `/auth`, not a pass-through;
- the path counts as a page with and without a locale prefix;
- dotted files (`/robots.txt`, `/llms.txt`, `/.well-known/…`) stay files.
