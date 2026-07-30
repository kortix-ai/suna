# Lumen white-label reference

Lumen is the complete reference app for `@kortix/sdk`.

The app has five architecture rules:

1. The browser creates one Kortix client in `src/lib/kortix.ts`.
2. One `useSession(projectId, sessionId)` hook owns each session workbench.
3. The client does not select or implement a runtime transport.
4. Server routes own privileged credentials and preview URL resolution.
5. Only the SDK transport layer sends Kortix backend HTTP requests.

The client renders the server-provided `experimental_features` catalog. It does
not hard-code a transport flag and does not know which transport a session
uses.

## Client boundary

Client code imports only:

- `@kortix/sdk`
- `@kortix/sdk/react`
- Local UI and application modules

Client code does not:

- Import a provider SDK.
- Construct runtime or preview proxy paths.
- Call provider REST endpoints.
- Use a legacy runtime store.
- Call `session.previewUrl()` or `session.proxyUrl()`.
- Select a session transport.
- Send raw requests to the Kortix backend.

`scripts/sdk-boundary.mjs` enforces these rules across client source, server
source, and application tests. The `build`, `test`, `test:e2e`, and `typecheck`
scripts run this check first.

## One SDK client

`src/lib/kortix.ts` creates the client once:

```ts
import { createKortix } from '@kortix/sdk';

export const kortix = createKortix({
  backendUrl: BRAND.apiUrl,
  getToken: async () => getApiKey(),
});
```

Wrapper mode reconfigures this same client. It does not create a second client.

## One session hook

The session route calls one hook:

```tsx
const session = useSession(projectId, sessionId);

return session.phase !== 'ready' ? (
  <BootScreen
    stage={session.stage}
    reason={session.reason}
    onRetry={session.retry}
  />
) : (
  <WorkbenchTabs
    session={session}
    projectId={projectId}
    sessionId={sessionId}
  />
);
```

The hook exposes the complete workbench contract:

- Lifecycle phase and retry state
- Transcript messages and incremental updates
- Send, cancel, and command actions
- Model and agent selections
- Questions and permission requests
- Session status, diffs, and todos

The host does not mount a second event provider. The host does not resolve a
provider session identifier.

## Project experiment

The project settings page reads `project.experimental_features`.

It renders each available feature by its server-provided label and description.
It updates a feature through:

```ts
kortix.project(projectId).updateExperimentalFeature(feature.key, enabled);
```

The host does not contain any experiment key. This keeps the app compatible
with future transports and runtimes.

## Server-first preview

The preview panel reads preview candidates through the session SDK handle.

It sends the selected port or localhost URL to `POST /api/preview-url`. The
server route:

1. Authenticates the caller.
2. Checks project ownership in wrapper mode.
3. Creates a request-scoped server SDK client.
4. Calls `session.ensureReady()`.
5. Resolves the preview URL through the SDK.
6. Mints a project-scoped preview token.
7. Returns one final authenticated URL.

The response does not expose a standalone token, upstream base URL, or runtime
coordinates.

## Deployment modes

Lumen supports two deployment modes. `GET /api/mode` selects the mode at
process startup.

### Direct mode

Direct mode is the default.

- The user pastes a Kortix API key.
- The browser stores it in `localStorage`.
- The shared SDK client targets `NEXT_PUBLIC_KORTIX_API_URL`.
- `/api/preview-url` uses the caller token for server-side preview resolution.

### Wrapper mode

Set `KORTIX_API_KEY` to enable wrapper mode.

- Users authenticate through `/api/auth/*`.
- The browser receives a Lumen session token.
- The shared SDK client targets `/api/kortix`.
- The BFF delegates forwarding to `@kortix/sdk/server`.
- The SDK substitutes `KORTIX_API_KEY` on upstream requests.
- `src/server/users.ts` enforces per-user project ownership.
- `src/server/policy.ts` applies a deny-by-default route policy.
- `src/server/rate-limit.ts` applies per-user limits.
- `/api/session-costs` applies the configured `COST_MARKUP` to session costs.

The Kortix API key remains server-side.

## Product surfaces

| Route                                 | SDK-backed surface                                                                               |
| ------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `/`                                   | Project list and provisioning                                                                    |
| `/account`                            | Accounts, members, roles, invites, and account projects                                          |
| `/projects/[id]`                      | Session creation, agent selection, model selection, and templates                                |
| `/projects/[id]/sessions/[sessionId]` | Chat, files, changes, previews, shares, and session actions                                      |
| `/projects/[id]/settings`             | General settings, experiments, capabilities, secrets, access, connectors, triggers, and policies |
| `/session-costs`                      | Wrapper session cost and markup report                                                           |

The app uses the following public SDK groups:

- `kortix.accounts`
- `kortix.projects`
- `kortix.project(projectId)`
- `kortix.session(projectId, sessionId)`
- `useSession(projectId, sessionId)`
- Project model, agent, and configuration hooks
- Headless turn classification and part rendering

## Auth

The SDK has one auth seam: `getToken`.

Direct mode returns the pasted Kortix API key. Wrapper mode returns the Lumen
session token. The BFF exchanges the Lumen session for the server-held Kortix
credential.

## Run

Install dependencies:

```bash
pnpm install
```

Run direct mode:

```bash
NEXT_PUBLIC_KORTIX_API_URL=https://api.kortix.com/v1 \
  WHITELABEL_PORT=3010 \
  pnpm --filter @kortix/whitelabel-demo dev
```

Run wrapper mode with the variables in `.env.example`:

```bash
KORTIX_API_KEY=kortix_pat_example \
KORTIX_UPSTREAM=https://api.kortix.com/v1 \
SESSION_SECRET=replace-with-a-long-random-value \
WHITELABEL_PORT=3010 \
pnpm --filter @kortix/whitelabel-demo dev
```

## Verify

Run all reference-app checks:

```bash
pnpm --filter @kortix/whitelabel-demo typecheck
pnpm --filter @kortix/whitelabel-demo build
pnpm --filter @kortix/whitelabel-demo test
```

The test suite boots the production Next.js server. Product flows create a
request-scoped SDK client. Tests do not construct Kortix backend requests. The
suite verifies auth, mode selection, ownership, route policy, proxy behavior,
preview resolution, rate limits, session cost markup, and the SDK boundary.

## Rebrand

- Product name, tagline, accent, and API URL: `src/config/brand.ts`
- Theme tokens: `src/app/globals.css`
- Direct-mode credential input: `src/components/api-key-gate.tsx`
- Wrapper authentication: `src/server/auth.ts`
- Wrapper authorization: `src/server/users.ts` and `src/server/policy.ts`

Keep `src/lib/kortix.ts` as the single client seam. Add missing backend behavior
to `@kortix/sdk` before using it in this app.
