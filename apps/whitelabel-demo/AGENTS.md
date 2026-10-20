# AGENTS.md — Lumen, the customer-facing reference

Lumen is the reference for a product that wraps Kortix for its own customers.
Lumen owns identity, organizations and data (Convex + Better Auth, `convex/`).
Kortix owns agents, sandboxes and sessions. The SDK is the only way to Kortix,
`@kortix/ui` is the UI, and the brand is a set of token overrides. README.md
has the authority split, the id mapping and the credential flow.

## Required architecture

1. `src/lib/kortix.ts` owns the only browser SDK client.
2. `useSession(projectId, sessionId)` owns the complete workbench session.
3. Client code imports Kortix only through `@kortix/sdk`, `@kortix/sdk/react`,
   `@kortix/sdk/genui*` and `@kortix/ui`. Every other `@kortix/sdk/<subpath>`
   is deprecated or internal, and the boundary refuses it.
4. Client code does not implement runtime transport logic.
5. Server Kortix calls use `@kortix/sdk/server`.
6. The `/api/kortix` route delegates upstream forwarding to `forwardKortixRequest()`.

Do not add:

- `@opencode-ai/sdk` imports.
- Provider REST paths.
- Runtime proxy URL construction.
- Browser calls to `session.previewUrl()` or `session.proxyUrl()`.
- Legacy runtime stores.
- A second SDK client.
- A second session event provider.
- A client-side transport selector.
- A raw Kortix `fetch()` in client or server code.

`scripts/sdk-boundary.mjs` enforces the client, server, and application-test
rules. Update its tests when a new same-origin application route is intentional.

Browser code never imports `@kortix/sdk/server` and never opens its own
transport (`EventSource`, `XMLHttpRequest`, `WebSocket`, `navigator.sendBeacon`,
an aliased `fetch` such as `const f = fetch` or `fetch.call(...)`). No source
file, Convex included, imports a raw HTTP client (`node:http(s)`, `undici`,
`axios`, `ky`, `got`, `node-fetch`, `cross-fetch`). The boundary is a source
scan: it catches these forms, not every way to write them.

## Server boundary

`src/app/api/**` and `src/server/**` are server-only.

- Use `createScopedKortix()` for request-scoped server SDK calls.
- Authenticate before parsing or forwarding privileged requests.
- Get the Kortix credential from `resolveMember` / `resolveMemberFor`
  (`src/server/member.ts`). Never take a project id from the client as the
  key to a credential.
- The operator credential lives only in Convex env (`KORTIX_OPERATOR_TOKEN`).
  Next.js never reads it. Member tokens never reach a response body.
- The proxy allowlists reads and writes. A new proxied route is an explicit
  entry in `src/server/proxy-policy.ts` with a test in
  `tests/unit/proxy-policy.test.ts`. Never allow an account route, a credential
  route or a member list: the member token is the operator's user.
- Never return a Kortix token to the browser, a preview URL included. A
  preview is a public preview share (`/api/preview-url`).

## Convex boundary

- Every Kortix call with the operator credential is a `"use node"` action in
  `convex/kortix.ts`. Other Convex files never import `@kortix/sdk`.
- Public queries return null or `[]` for a non-member; mutations and actions
  throw `"403: …"`. The status prefix is what the proxy maps to HTTP.
- Store each Kortix id next to the Lumen id that owns it. Tag sessions with
  `lumenSessionTags`, and a client-built session body with `tagSessionCreate`
  (`convex/tags.ts`); never add a Lumen concept to a Kortix API.
- Raw errors stay in `auditEvents`. A field a member reads holds generic text.
- `convex/_generated/` and `convex/betterAuth/generatedSchema.ts` are
  generated. Regenerate with `npx convex dev` and the Better Auth CLI command
  in that file's header.
- Return provider-neutral response fields.
- Validate identifiers before interpolating them into SDK calls.

`POST /api/preview-url` owns session readiness and preview URL resolution. The
client receives one final URL: a Kortix public preview share that expires
after 15 minutes. Do not return a token, an upstream base URL, or runtime
coordinates.

The `/api/kortix` route calls `forwardKortixRequest()` from
`@kortix/sdk/server`. The SDK owns upstream authentication, request buffering,
streaming, and response-header sanitization.

## UI boundary: compose @kortix/ui, theme through tokens

The app has no UI kit of its own. `src/components/ui/` does not exist and must
not come back.

- Import every primitive from `@kortix/ui/<name>` (`button`, `input`,
  `textarea`, `select`, `switch`, `modal`, `confirm-dialog`, `card`, `badge`,
  `tabs`, …). Never `@kortix/ui/dialog`: it is the primitive `modal` builds on.
- The session chat is `<SessionThread>` from `@kortix/ui/session`, the same
  thread apps/web renders. Lumen adds only its scope bar under it. Never
  re-implement the transcript, composer or prompts.
- Toasts: `successToast` / `errorToast` / `infoToast` / `warningToast` from
  `@kortix/ui/toast`. `providers.tsx` mounts its `<Toaster />` once.
- `cn` comes from `@kortix/ui` (the root entry). Never import a deep
  `@kortix/ui/<module>/<path>`.
- Icons: `@phosphor-icons/react` (`<Name>Icon`), the set @kortix/ui renders.
- Use `Loading` (`@kortix/ui/loading`) for pending actions and `Skeleton` for
  page-level loading.
- Add accessible names to icon-only controls. Preserve keyboard actions.
- `providers.tsx` mounts `<UiProvider>` once. Do not mount another.

Theming happens through one typed theme, `src/config/theme.ts`
(`KortixTheme` from `@kortix/ui/theme`). `src/app/layout.tsx` compiles it with
`themeToCss` into one `<style>` in `<head>`, so the first paint is on brand.
It sets the colors per mode, the radius (`0.875rem`), the spacing step
(`0.25rem`), the shadows, the durations and easing, and the fonts. Lumen's
brand is `--brand`; `blue` (switches, checkboxes, radios, the brand Button and
Badge variants, info alerts), `action` and `actionForeground` (the default
Button fill), `ring`, `primary`, `sidebarPrimary` and `selection` point at it.
`src/app/globals.css` only imports `tailwindcss` and `@kortix/ui/tailwind.css`
and maps `--brand` to `bg-brand` / `text-brand` and the heading serif to
`font-display`. Never fork or wrap a component to change a color, radius or
font. Never import `@kortix/ui/fonts.css`: Lumen's fonts are its own
(Instrument Sans, Instrument Serif for headings, JetBrains Mono), loaded with
`next/font` in `src/app/layout.tsx`.

`src/app/providers.tsx` mounts `UiProvider` once with Lumen's mark
(`useBrand` → `LUMEN_UI_BRAND`), the host config (no CLI bar, no public share
links, no terminal; `accountApiEnabled` stays on so the proxy's local "denied"
probe answers hide the configuration controls), `resolvePreviewUrl` (sandbox
previews resolve through `POST /api/preview-url`) and `setUiRoutes` (every
page Lumen does not serve is `null`, so its links are hidden).

A missing primitive or chat slot is added to `packages/ui`, not to this app.

`scripts/sdk-boundary.mjs` rejects: any file under `src/components/ui`,
imports of a local UI primitive, `lucide-react`, `radix-ui`, `@radix-ui/*`,
`class-variance-authority`, `next-themes` or `react-markdown`, a direct sonner
`toast` import, `@kortix/ui/dialog` (use `modal` or `confirm-dialog`), native
feature controls (`<button>`, `<input>`, …) and feature-level spinners.

## Structure

- `src/lib/kortix.ts`: One browser SDK client.
- `src/app/globals.css`: `@kortix/ui` tokens + theme, and the white-label overrides.
- `src/components/chat/scope-bar*`: Lumen's session-scope chips (the
  `SessionThread` composer footer).
- `src/components/workbench/`: Session workbench. Files and Changes read the
  thread's branch (`useSessionRef`, `src/lib/session-ref.ts`) and leave out the
  workspace configuration (`isCustomerFile`).
- `src/app/**`: Route components.
- `src/app/api/**`: Same-origin server endpoints.
- `src/server/**`: Better Auth helpers, member token resolution, and the proxy policy.
- `convex/**`: Lumen's backend (schema, auth, workspaces, threads, Kortix actions).
- `tests/unit/**`: unit tests under bun (proxy policy, tagging, member cache, boundary, UI helpers).
- `tests/convex/**`: Convex backend tests under vitest + `convex-test`.

## Required checks

Run these commands before each commit:

```bash
pnpm --filter @kortix/whitelabel-demo typecheck
pnpm --filter @kortix/whitelabel-demo build
cd apps/whitelabel-demo && bun test tests/unit/<the files you touched> && pnpm test:convex
```

All three commands must exit `0`. The SDK boundary must report `0 violations`.

## Customer data

Never write customer names, people's names, emails, or real prod IDs into code,
commits, PRs, docs, or comments. The full rule and the commit guard are in the
root `AGENTS.md` → "NEVER write customer data or PII".

## Design references

This app's UI is the Kortix design system (`@kortix/ui`, source in
`packages/ui`) re-themed by token overrides. Component rules are in
`.agents/skills/kortix-design-system/SKILL.md`; token values in
`.agents/skills/kortix-brand/SKILL.md`. Brand voice and the Roobert font do
not apply: this is a white-label surface.
