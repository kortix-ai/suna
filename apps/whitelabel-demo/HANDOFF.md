# Whitelabel Demo Handoff

## Where This Work Lives

- Worktree: `/Users/markokraemer/Projects/kortix/suna-whitelabel-demo`
- Branch: `whitelabel-demo`
- App: `apps/whitelabel-demo`
- Current local demo URL when started: `http://localhost:3010`
- Package name: `@kortix/whitelabel-demo`

This work is currently uncommitted. `git status --short --untracked-files=all` shows a new untracked `apps/whitelabel-demo` package and a modified `pnpm-lock.yaml`.

## User Sentiment / Important Context

The user does not like the current result and considers it below the desired bar. They explicitly asked for something closer to a Vercel / Claude / Cursor / high-end Kortix standard, not a rookie scaffold.

The current implementation is a functional and more polished starter than the first pass, but it should be treated as a working prototype, not final product direction. The next thread should be willing to substantially redesign or replace the UI again.

Specific user complaints that must be preserved:

- The UI still does not feel "Vercel level".
- The session page originally lacked a continuing chat input; that was added, but it is currently a local whitelabel simulation, not a true live OpenCode follow-up send.
- The user wants custom tool renderers, artifacts panel, right-side output, session UX, and all small details aligned with core Kortix.
- The user wants the front-end codebase clean, not a hacked demo.
- The user wants to reuse the main Kortix UX/UI as reference while keeping this a generic whitelabel demo.

## What Was Built

`apps/whitelabel-demo` is a standalone full-stack Next.js app inside the Kortix monorepo. It demonstrates a whitelabel frontend that owns its own demo auth/session store while adapting the Kortix backend as the project/session source of truth.

Main capabilities:

- Server-side demo auth using a local JSON store and HTTP-only cookie.
- Demo registration and login pages.
- Passive project home with a starter composer.
- Backend-backed project provisioning through Kortix `/projects/provision`.
- Backend-backed session creation through Kortix `/projects/:projectId/sessions`.
- Session start/polling through Kortix `/projects/:projectId/sessions/:sessionId/start`.
- Session transcript polling through Kortix `/projects/:projectId/sessions/:sessionId/transcript`.
- Raw OpenCode artifact extraction through `/p/:externalId/8000/session/:opencodeSessionId/message`.
- SSE endpoint for the whitelabel UI at `/api/sessions/:sessionId/events`.
- Session page with timeline, tool cards, artifact tabs, runtime panel, tools panel, and sticky follow-up composer.
- Mock Kortix API for E2E and local demo without a real backend token.
- Optional real-backend E2E smoke path with `WHITELABEL_E2E_REAL_BACKEND=1`.

## Important Files

### App Entry / Pages

- `src/app/layout.tsx`
  - Metadata and global CSS import.
- `src/app/page.tsx`
  - Auth-gated project home.
  - Shows sidebar shell, topbar, suggestions, and new-session composer.
  - Uses `createSessionAction`.
- `src/app/login/page.tsx`
  - Login route rendering `AuthForm`.
- `src/app/register/page.tsx`
  - Register route rendering `AuthForm`.
- `src/app/logout/page.tsx`
  - Clears demo cookie/session and redirects to login.
- `src/app/sessions/[sessionId]/page.tsx`
  - Main session page.
  - Loads user, local run mapping, and initial Kortix session state.
  - Renders `DashboardShell` and `SessionStatus`.
- `src/app/runs/[sessionId]/page.tsx`
  - Compatibility redirect to `/sessions/:sessionId`.
- `src/app/api/sessions/[sessionId]/events/route.ts`
  - SSE endpoint consumed by the session page.
  - Authenticates demo cookie.
  - Looks up local run mapping.
  - Polls Kortix session/start/transcript/artifacts.
  - Merges local whitelabel follow-up turns from the store.
  - Emits `snapshot` events and a final `complete` event.

### Components

- `src/components/auth-form.tsx`
  - Shared login/register form.
- `src/components/dashboard-shell.tsx`
  - Project-like left sidebar.
  - Shows workspace card, session list, new-session button, and demo user card.
- `src/components/run-status.tsx`
  - Main session workbench component.
  - Despite the filename, this now exports `SessionStatus`.
  - Owns the client EventSource connection.
  - Renders:
    - timeline toolbar
    - user/assistant timeline cards
    - custom tool cards
    - sticky follow-up composer
    - runtime side panel
    - artifact tabs and markdown preview
    - tools activity panel
  - Also exports `RunStatus = SessionStatus` for compatibility.

### Server / Adapter / Store

- `src/lib/actions.ts`
  - Server actions:
    - `loginAction`
    - `registerAction`
    - `logoutAction`
    - `createSessionAction`
    - `continueSessionAction`
  - `continueSessionAction` currently records local follow-up turns in the whitelabel store. It does not call live OpenCode `session.prompt`.
- `src/lib/auth.ts`
  - Local demo auth.
  - Cookie name: `kortix_whitelabel_demo_session`.
  - Passwords are scrypt-hashed with random salt.
- `src/lib/config.ts`
  - Reads:
    - `WHITELABEL_DATA_DIR`
    - `WHITELABEL_KORTIX_API_URL`
    - `KORTIX_API_URL`
    - `KORTIX_API_PROXY_TARGET`
    - `WHITELABEL_KORTIX_TOKEN`
- `src/lib/kortix.ts`
  - Kortix backend adapter.
  - Handles provision, get/list/create/start session, transcript, raw OpenCode messages, artifact extraction.
  - Important seam for future real follow-up sending.
  - Current metadata product: `kortix-whitelabel-demo`.
- `src/lib/research.ts`
  - Misleading filename from earlier iteration.
  - Now contains `buildSessionPrompt`.
  - Should probably be renamed to `prompt.ts` or `session-prompt.ts`.
- `src/lib/store.ts`
  - JSON file store.
  - Types:
    - `DemoUser`
    - `DemoSession`
    - `DemoRun`
    - `DemoTurn`
  - Stores users, browser sessions, run/session mappings, and local follow-up turns.

### Styling

- `src/app/globals.css`
  - All whitelabel app CSS.
  - Contains app shell, sidebar, home, session workbench, timeline cards, tool cards, artifact side panel, auth form, responsive styles.
  - This is custom CSS, not using the main `apps/web` UI primitives directly.
  - It follows neutral Kortix-like styling, but not the actual shared component library.

### Tests / Mock Backend

- `tests/e2e/dev-server.mjs`
  - Starts a mock Kortix API on `WHITELABEL_MOCK_API_PORT` default `3108`.
  - Starts Next dev server on `WHITELABEL_PORT` default `3010`.
  - Resets `WHITELABEL_DATA_DIR` default `.data/e2e`.
  - Mock routes:
    - `POST /v1/projects/provision`
    - `POST /v1/projects/:projectId/sessions`
    - `POST /v1/projects/:projectId/sessions/:sessionId/start`
    - `GET /v1/projects/:projectId/sessions/:sessionId/transcript`
    - `GET /v1/projects/:projectId/sessions/:sessionId`
    - `GET /v1/p/:externalId/8000/session/:opencodeSessionId/message`
  - Mock transcript stages assistant/tool/assistant messages over time.
  - Mock raw messages produce `docs/implementation-checklist.md`.
- `tests/e2e/whitelabel-flow.spec.ts`
  - Browser E2E:
    - registers demo user
    - starts a session
    - verifies timeline streaming
    - verifies artifact panel
    - sends a follow-up through the session composer
    - verifies local follow-up timeline and artifact state
  - Supports real-backend smoke expectations when `WHITELABEL_E2E_REAL_BACKEND=1`.

## How To Run

From worktree root:

```bash
cd /Users/markokraemer/Projects/kortix/suna-whitelabel-demo
pnpm --filter @kortix/whitelabel-demo test
pnpm --filter @kortix/whitelabel-demo typecheck
pnpm --filter @kortix/whitelabel-demo build
pnpm --filter @kortix/whitelabel-demo test:e2e
```

Start the local demo with mock backend:

```bash
cd /Users/markokraemer/Projects/kortix/suna-whitelabel-demo/apps/whitelabel-demo
node tests/e2e/dev-server.mjs
```

Then open:

```text
http://localhost:3010
```

The server started by this thread was left running at `http://localhost:3010` at handoff time.

## Environment Variables

For normal mock mode:

- No secrets required.
- `tests/e2e/dev-server.mjs` injects:
  - `WHITELABEL_KORTIX_TOKEN=kortix_pat_mock`
  - `WHITELABEL_KORTIX_API_URL=http://127.0.0.1:3108/v1`

Optional variables:

- `WHITELABEL_PORT`
  - Next app port. Default `3010`.
- `WHITELABEL_MOCK_API_PORT`
  - Mock API port. Default `3108`.
- `WHITELABEL_DATA_DIR`
  - Local JSON store dir. Default `.data` in regular dev, `.data/e2e` in test server.
- `WHITELABEL_KORTIX_API_URL`
  - Real or mock Kortix API URL, expected to include `/v1`.
- `WHITELABEL_KORTIX_TOKEN`
  - JWT or PAT used by the server-side adapter.
- `WHITELABEL_E2E_REAL_BACKEND=1`
  - Disables mock API in the dev-server harness and uses supplied real backend URL/token.

## Verification Already Run

These passed after the latest refactor:

```bash
pnpm --filter @kortix/whitelabel-demo typecheck
pnpm --filter @kortix/whitelabel-demo test
pnpm --filter @kortix/whitelabel-demo build
pnpm --filter @kortix/whitelabel-demo test:e2e
```

Also manually ran Playwright screenshot checks against desktop and mobile:

- Desktop viewport: `1440x1000`
- Mobile viewport: `390x900`
- Checked:
  - no horizontal overflow
  - no large element overlaps
  - full session flow renders
  - follow-up composer adds local turns
  - artifact panel shows initial and follow-up artifacts

Screenshots were generated under:

```text
apps/whitelabel-demo/test-results/vercel-level-pass/
```

`test-results/` is ignored by the app `.gitignore`.

## Real Backend Smoke That Was Done Earlier

A real local Kortix API was running on `http://localhost:8008/v1`, with local Supabase on `54321`. A local JWT was minted manually using the local Supabase dev secret, and this command passed once:

```bash
WHITELABEL_E2E_REAL_BACKEND=1 \
WHITELABEL_KORTIX_TOKEN="$(cat /tmp/userjwt-whitelabel-fresh)" \
WHITELABEL_KORTIX_API_URL=http://localhost:8008/v1 \
pnpm --filter @kortix/whitelabel-demo exec playwright test --timeout=420000
```

The first live retry failed because the same free user had already provisioned one project and hit the local free-account project limit. Minting a fresh user/token fixed it.

This real-backend smoke verifies project/session creation and runtime stream state. It does not verify a real OpenCode follow-up send from the whitelabel composer.

## Current Architecture

### Source Of Truth Split

The app intentionally splits state:

- Local whitelabel source of truth:
  - demo users
  - demo browser sessions
  - mapping from demo user to Kortix project/session ids
  - local follow-up turns added via the session-page composer
- Kortix backend source of truth:
  - project provisioning
  - session creation
  - session status
  - branch/sandbox/OpenCode identity
  - transcript
  - raw OpenCode message-derived artifacts

This was built to demonstrate the "whitelabel frontend wraps Kortix backend" mental model.

### Session Flow

1. User registers or logs in.
2. `/` calls `requireCurrentUser`.
3. User submits project-home composer.
4. `createSessionAction`:
   - gets or provisions Kortix workspace with `ensureWorkspaceForUser`
   - creates Kortix project session with `createDemoSession`
   - remembers local mapping with `rememberRun`
   - redirects to `/sessions/:sessionId`
5. Session page loads:
   - current user
   - local run list
   - local run mapping
   - initial Kortix session snapshot
6. `SessionStatus` opens EventSource:
   - `/api/sessions/:sessionId/events`
7. SSE route loops:
   - `client.getSession`
   - `client.startSession`
   - `client.getTranscript`
   - `getSessionArtifacts`
   - `listTurnsForRun`
   - emits merged snapshot
8. UI builds timeline from:
   - initial prompt
   - backend transcript messages
   - local whitelabel turns
9. UI builds artifact panel from:
   - backend extracted artifacts
   - local follow-up turn artifacts
10. User can submit follow-up from sticky composer.
11. `continueSessionAction` appends local turns and redirects back to the session.

## Known Limitations / Things To Fix Next

These are important. Do not present the current result as final.

### 1. Follow-Up Composer Is Not A Real OpenCode Send

`continueSessionAction` currently appends local simulated turns:

- user prompt
- `workspace:inspect` tool turn
- assistant response
- `docs/session-follow-up.md` local artifact

It does not call OpenCode `session.prompt`.

Core Kortix uses OpenCode SDK `client.session.prompt(payload)` in `apps/web/src/hooks/opencode/use-opencode-sessions.ts`. The proper future path is to expose a safe server-side adapter in `src/lib/kortix.ts` that sends prompts through the Kortix backend/proxy to the pinned OpenCode session.

### 2. UI Is Still Custom CSS, Not True Shared Kortix Primitives

The app read the design guidance from `.claude/skills/kortix-design-system/SKILL.md`, but `apps/whitelabel-demo` does not import the `apps/web/src/components/ui/*` design system. It hand-rolls local CSS.

If the goal is a serious starter, next pass should either:

- package/reuse selected primitives from `apps/web`, or
- create a local mini design system in `apps/whitelabel-demo/src/components/ui/*` with Button, Badge, Panel, ListRow, Avatar, Composer, Tabs, DefinitionList, ToolCard, ArtifactPreview.

Current component architecture is better than before but still too centralized in `run-status.tsx`.

### 3. `run-status.tsx` Is Misnamed And Too Large

It now contains the entire session workbench:

- EventSource client
- timeline mapping
- timeline cards
- tool cards
- runtime panel
- artifact panel
- markdown preview
- composer

Next pass should split it into:

- `components/session/session-workbench.tsx`
- `components/session/session-stream.ts`
- `components/session/timeline.tsx`
- `components/session/tool-card.tsx`
- `components/session/artifact-panel.tsx`
- `components/session/runtime-panel.tsx`
- `components/session/session-composer.tsx`
- `components/session/types.ts`

### 4. `research.ts` Filename Is Stale

`src/lib/research.ts` now builds a generic session prompt. Rename to:

- `src/lib/session-prompt.ts`

And update imports/tests.

### 5. Artifact Tabs Are Not Interactive Yet

The current artifact panel renders all artifact tabs but always previews the first artifact. It looks like tabs but does not switch selected artifact.

Fix by adding client state to `ArtifactPanel`:

- `selectedFile`
- choose selected artifact by file
- active tab follows selection

### 6. The Mock Backend Is Better But Still Too Synthetic

`tests/e2e/dev-server.mjs` stages transcript by elapsed time and emits canned messages. This is useful for deterministic E2E, but it still does not fully model real OpenCode parts/tool shapes.

Next pass should mock closer to real OpenCode message payloads, including:

- text parts
- tool parts
- status transitions
- diff summaries
- file attachments
- failed tool state
- streaming/in-progress partials if desired

### 7. Visual Quality Is Improved But Still May Not Meet User Bar

The latest screen is materially better:

- neutral workspace shell
- session timeline
- tool cards
- sticky composer
- right artifact/runtime/tools panel
- mobile stacked layout

But the user asked for "Vercel level", and they may still reject it. Next thread should assume a deeper redesign is allowed.

Suggested next visual direction:

- Reference core Kortix project/session pages directly.
- Use a command/workbench feel, less boxed-card repetition.
- Make the timeline feel more like a polished agent transcript, not a stack of generic cards.
- Improve topbar density and session title/tab model.
- Make tool renderers feel like actual tool outputs, not just text blocks.
- Make artifact panel interactive and primary, similar to Cursor/Claude artifact surfaces.

## Current File/Change Scope

New untracked app files:

```text
apps/whitelabel-demo/.gitignore
apps/whitelabel-demo/next-env.d.ts
apps/whitelabel-demo/next.config.ts
apps/whitelabel-demo/package.json
apps/whitelabel-demo/playwright.config.ts
apps/whitelabel-demo/src/app/api/sessions/[sessionId]/events/route.ts
apps/whitelabel-demo/src/app/globals.css
apps/whitelabel-demo/src/app/layout.tsx
apps/whitelabel-demo/src/app/login/page.tsx
apps/whitelabel-demo/src/app/logout/page.tsx
apps/whitelabel-demo/src/app/page.tsx
apps/whitelabel-demo/src/app/register/page.tsx
apps/whitelabel-demo/src/app/runs/[sessionId]/page.tsx
apps/whitelabel-demo/src/app/sessions/[sessionId]/page.tsx
apps/whitelabel-demo/src/components/auth-form.tsx
apps/whitelabel-demo/src/components/dashboard-shell.tsx
apps/whitelabel-demo/src/components/run-status.tsx
apps/whitelabel-demo/src/lib/actions.ts
apps/whitelabel-demo/src/lib/auth.ts
apps/whitelabel-demo/src/lib/config.ts
apps/whitelabel-demo/src/lib/kortix.ts
apps/whitelabel-demo/src/lib/research.test.ts
apps/whitelabel-demo/src/lib/research.ts
apps/whitelabel-demo/src/lib/store.ts
apps/whitelabel-demo/tests/e2e/dev-server.mjs
apps/whitelabel-demo/tests/e2e/whitelabel-flow.spec.ts
apps/whitelabel-demo/tsconfig.json
```

Modified existing file:

```text
pnpm-lock.yaml
```

The lockfile adds the `apps/whitelabel-demo` importer and one `@types/node@22.20.0` package entry.

## Recommended Next Steps

1. Decide whether to keep this prototype or restart the whitelabel app UI from a cleaner component breakdown.
2. Split `run-status.tsx` into focused components before adding more features.
3. Implement real artifact tab selection.
4. Rename `research.ts` to `session-prompt.ts`.
5. Wire real follow-up send through the Kortix/OpenCode backend if possible.
6. Build proper local UI primitives or import/share core Kortix design primitives.
7. Rework visual hierarchy toward a polished agent workbench:
   - left sessions
   - top tab/session bar
   - center transcript/timeline with persistent composer
   - right artifact/tool/runtime panel
8. Expand E2E to assert:
   - tab switching in artifact panel
   - follow-up persistence after page reload
   - mobile composer visibility
   - tool renderer variants
   - error state rendering
9. Run the same verification loop:

```bash
pnpm --filter @kortix/whitelabel-demo typecheck
pnpm --filter @kortix/whitelabel-demo test
pnpm --filter @kortix/whitelabel-demo build
pnpm --filter @kortix/whitelabel-demo test:e2e
```

10. Do browser visual checks on:

```text
1440x1000
390x900
```

Check specifically for:

- no horizontal overflow
- composer visible and usable
- right panel not empty
- timeline does not look like generic cards
- tool output has a custom renderer
- artifacts are inspectable
- mobile stacking is coherent

## Current Server State

At the time this handoff was written, a dev server was running from:

```text
/Users/markokraemer/Projects/kortix/suna-whitelabel-demo/apps/whitelabel-demo
```

On:

```text
http://localhost:3010
```

If you need to stop it in a later thread, check ports:

```bash
lsof -nP -iTCP:3010 -sTCP:LISTEN
lsof -nP -iTCP:3108 -sTCP:LISTEN
```

Then stop the matching `node tests/e2e/dev-server.mjs` / `next dev` process if still running.
