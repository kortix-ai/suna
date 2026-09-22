# Kortix Mobile App

> ## ⚠️ Partly reconsolidated — read before changing anything here
>
> **This app is not part of the current release path.** The session layer has
> been moved onto `@kortix/sdk`; the rest has not.
>
> ### What is done
>
> - **Sessions go through the SDK.** A session is addressed as
>   `(projectId, sessionId)` in KORTIX ids and driven by `useSession` from
>   `@kortix/sdk/react` — the same hook `apps/web`, the Electron desktop app,
>   the TUI and `apps/whitelabel-demo` use. The host's parallel stack
>   (`sync-store.ts`, `session-sync.ts`, `event-stream.ts`, and the session
>   half of `lib/platform/hooks.ts`) is deleted.
> - **Saved transcript history works.** Because the session is addressed by its
>   Kortix id, `useSession` drives `useSessionTranscriptHistory`, so a stopped
>   or still-waking session paints its thread from the durable server-side
>   mirror instead of showing nothing. Older windows page in on scroll via the
>   `before=` cursor.
> - **Streaming is shared.** `react-native-sse` supplies the bytes through the
>   SDK's `EventStreamTransport` seam
>   (`lib/opencode/react-native-event-stream-transport.ts`, ~44 lines). Every
>   reconnect, backoff, heartbeat and coalescing decision is the SDK's. The
>   655-line second copy of that logic is gone.
> - **One client per host**, via `configureKortix({ backendUrl, getToken })` in
>   `app/_layout.tsx`.
>
> ### What is still stale
>
> - **The model/agent catalog** (`lib/opencode/hooks/use-opencode-data.ts`,
>   `use-local-config.ts`) is still host-side and keyed on a sandbox url. It is
>   fed the session's own `runtimeUrl` now rather than a global sandbox, but the
>   resolution logic belongs in the SDK. It also groups models by
>   `providerName`, which is always `"Kortix"` under the gateway, so its model
>   list still disagrees with the web app's.
> - **`lib/opencode/types.ts`** re-exports the SDK's wire types rather than
>   redeclaring them, but still holds mobile-only view types.
> - **Archiving a session is gone.** It was an OpenCode-session feature; a
>   Kortix session has no archived state (`archived_at` exists only on the
>   OpenCode sub-session snapshot). Deleting still works. Restoring archive
>   needs a product decision and a server-side field.
> - **There is no typecheck in CI for this app.** `tsc --noEmit` reports 48
>   pre-existing errors on `main`; that number is the working baseline, not a
>   clean bill of health.
>
> ### If you are here to change something
>
> Put session, transport and data logic in `packages/sdk`. A fix applied only to
> this app will likely be discarded by the rest of the reconsolidation.

## Local development

See the repo root `AGENTS.md` / `CLAUDE.md` for the full local stack. Mobile runs
against the local API in the iOS simulator; expect setup friction while this app
is parked.
