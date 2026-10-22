---
recorded: 2026-10-01T21:33:40Z
incident_date: 2026-10-02
---
# Give every Web Crypto call in the SDK a host that has it: Hermes has no crypto global, so mobile polyfills it before any SDK call

**Rule:** `@kortix/sdk` may call `crypto.getRandomValues` / `crypto.randomUUID`
only because every host provides Web Crypto. Mobile (Hermes) has no `crypto`
global: `apps/mobile/lib/polyfills/web-crypto.ts` installs it from `expo-crypto`
and is the first import of `apps/mobile/app/_layout.tsx`. Never remove that
import, and never ship an SDK change that adds a Web Crypto call without the
app running it on Hermes once.

**Trigger surface:** Editing SDK code that mints ids or randomness
(`packages/sdk/src/core/session/wire-message-id.ts`, attachment ids, hashes),
or the mobile app's entry imports.

**Incident:** 2026-10-02. SDK #8648 and #8655 made the wire message id tail
default to `crypto.getRandomValues`. On mobile, opening a fresh thread called
`seedFirstPrompt` → `mintWireMessageId`, which threw "Property 'crypto' doesn't
exist". The throw landed between `setConnectingProjectSessionId(null)` and
`navigateToSession(threadId)`, so one render read "nothing open", the project
view route popped itself, and every home send landed back on project home
(dev/local, Expo Go). Bun tests run on V8, which has `crypto`, so nothing went
red. Fixed by the polyfill and by ordering the open as "new state first, old
state cleared after" in `lib/session/project-connect.ts`.

**Enforcement:** `apps/mobile/lib/polyfills/web-crypto.test.ts` (the polyfill
installs both functions when the engine has none). None yet for a new SDK Web
Crypto call reaching Hermes: a Hermes smoke over id minting would catch it.
