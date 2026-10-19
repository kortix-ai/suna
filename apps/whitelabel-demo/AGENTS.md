# AGENTS.md — Lumen white-label reference

Lumen is the reference implementation for `@kortix/sdk` and `@kortix/ui`.
Every white-label host copies this shape: the SDK is the data layer, `@kortix/ui`
is the UI, and the brand is a set of CSS variable overrides.

## Required architecture

1. `src/lib/kortix.ts` owns the only browser SDK client.
2. `useSession(projectId, sessionId)` owns the complete workbench session.
3. Client code imports Kortix only through `@kortix/sdk`, `@kortix/sdk/react`
   and `@kortix/ui`.
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

Application tests use `createTestKortix()` for Kortix product flows. Raw HTTP
is limited to application-owned routes such as auth, mode, preview, and usage.

## Project experiments

The settings page must:

- Read `project.experimental_features`.
- Render only entries with `available === true`.
- Use each entry's server-provided label and description.
- Call `updateExperimentalFeature(feature.key, enabled)`.

Do not hard-code project experiment keys in client code.

## Server boundary

`src/app/api/**` and `src/server/**` are server-only.

- Use `createScopedKortix()` for request-scoped server SDK calls.
- Authenticate before parsing or forwarding privileged requests.
- Check project ownership before wrapper-mode project actions.
- Keep `KORTIX_API_KEY` outside all response bodies.
- Return provider-neutral response fields.
- Validate identifiers before interpolating them into SDK calls.

`POST /api/preview-url` owns session readiness and preview URL resolution. The
client receives one final URL. Do not return a standalone preview token,
upstream base URL, or runtime coordinates.

The `/api/kortix` route calls `forwardKortixRequest()` from
`@kortix/sdk/server`. The SDK owns upstream authentication, request buffering,
streaming, and response-header sanitization.

## UI boundary: compose @kortix/ui, theme through tokens

The app has no UI kit of its own. `src/components/ui/` does not exist and must
not come back.

- Import every primitive from `@kortix/ui/<name>` (`button`, `input`,
  `textarea`, `select`, `switch`, `dialog`, `card`, `badge`, `tabs`, …).
- The session chat is `<SessionThread>` from `@kortix/ui/session`, the same
  thread apps/web renders. Lumen adds only its scope bar under it. The
  new-session form reuses `ModelPicker` and `AgentPicker` from
  `@kortix/ui/session`; never re-implement the transcript, composer or prompts.
- Toasts: `successToast` / `errorToast` / `infoToast` / `warningToast` from
  `@kortix/ui/toast`. `providers.tsx` mounts its `<Toaster />` once.
- `cn` comes from `@kortix/ui/lib/utils`.
- Icons: `@phosphor-icons/react` (`<Name>Icon`), the set @kortix/ui renders.
- Use `Loading` (`@kortix/ui/loading`) for pending actions and `Skeleton` for
  page-level loading.
- Add accessible names to icon-only controls. Preserve keyboard actions.
- `providers.tsx` mounts `<UiProvider link={NextLink}>` once. Do not mount
  another.

Theming happens only in `src/app/globals.css`: it imports `tailwindcss` and
`@kortix/ui/tailwind.css` (tokens, component layer, `tw-animate-css` and the
scrollbar plugins), then overrides token variables in `:root` (light) and
`.dark` (dark). Lumen's brand is `--brand`; `--kortix-blue` (the accent of
switches, checkboxes, radios, the brand Button and Badge variants and info
alerts), `--ring`, `--sidebar-primary`, `--sidebar-ring` and `--selection`
point at it. Never fork
or wrap a component to change a color, radius or font. Never import
`@kortix/ui/fonts.css`: white-label surfaces use the system font stack.

A missing primitive or chat slot is added to `packages/ui`, not to this app.

`scripts/sdk-boundary.mjs` rejects: any file under `src/components/ui`,
imports of a local UI primitive, `lucide-react`, `radix-ui`, `@radix-ui/*`,
`class-variance-authority`, `next-themes` or `react-markdown`, a direct sonner
`toast` import, native feature controls (`<button>`, `<input>`, …) and
feature-level spinners.

## Structure

- `src/lib/kortix.ts`: One browser SDK client.
- `src/app/globals.css`: `@kortix/ui` tokens + theme, and the white-label overrides.
- `src/components/chat/scope-bar*`: Lumen's session-scope chips (the
  `SessionThread` composer footer).
- `src/components/workbench/`: Session workbench.
- `src/app/**`: Route components.
- `src/app/api/**`: Same-origin server endpoints.
- `src/server/**`: Wrapper authentication, authorization, policy, and limits.
- `tests/e2e/**`: Production-server black-box tests.

## Required checks

Run these commands before each commit:

```bash
pnpm --filter @kortix/whitelabel-demo typecheck
pnpm --filter @kortix/whitelabel-demo build
pnpm --filter @kortix/whitelabel-demo test
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
