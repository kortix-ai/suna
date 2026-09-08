Project creation restored, complete localization, and headless auth

### New
- Every supported language now has complete translations across settings, onboarding, project home and sidebar, sessions, password recovery, sign-in, and workspace administration. Serbian is a new locale. 241 entries that rendered as placeholders now show real text.
- Headless auth: multi-factor enrolment, enterprise SSO, and profile updates are available through the API and the SDK (`PATCH /v1/auth/user`, `KortixSession.subscribe` as the replacement for `onAuthStateChange`).
- Kortix Apps: one identity guard for every App (`createKortixAppGuard`, groups always populated), and an embedded App can complete its own sign-in (`cookieSameSite`).
- Session brief: hover a session to see its summary.

### Improved
- Connector catalogue: one-letter searches work, cache entries are compared by identity, and panel padding and search were corrected.
- Markdown code blocks inside lists are inset correctly.
- Slack and Teams: a live run keeps its thread after 15 quiet minutes.
- Triggers: a billing-rejected fire is terminal and keeps its reason code; a reuse, keyed, or pinned delivery handoff is recorded as fired.

### Fixed
- Project creation: a failure while creating the managed repository is now logged with its cause. The edge router in front of the API is deployed with every release, so an origin error is never shown as a maintenance page. The managed-git token is verified by creating and deleting a probe repository before it is stored, and the status endpoint reports which credential is in use.
- Connector endpoints must be https on a public host. An invalid endpoint answers 400 instead of failing as a server error.
- Session attachments are reliable again.
- Kortix Apps: the App guard's trailing-slash handling could take seconds on one config string; the viewer secret is resolved per request; the access picker no longer promises options the code does not offer.
- MFA unenrol route typechecks (`gotrue()` accepts DELETE).

### Internal
- Template preview images (`/api/og/template`) render on the Node runtime with their strings inlined; as an Edge Function the route had grown past Vercel's size limit.
- Preview environments: Node repaired in persistent sandboxes, failed Platinum templates recover, an explicit Daytona fallback, all runtime secrets forwarded, Node engine floor raised, translations kept out of the edge middleware bundle.
- Release gate: follows the deployed test contracts, installs with engine-strict relaxed, verifies the host-only access cookie.
- Route manifest and audit route registry regenerated; the headless auth routes are registered and allowlisted with reasons.
- pi-js-router: `open_access` is the operator's override and the workflow honours it.
