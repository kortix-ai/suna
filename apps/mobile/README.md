# Kortix Mobile App

> ## Runtime layer
>
> The session runtime is `@kortix/sdk`'s. `app/_layout.tsx` configures one
> client (`configureKortix`), with `react-native-sse` as the live stream
> transport (`lib/session/sse-transport.ts`). `SandboxProvider` mounts one
> `useSession` for the open session (`components/session/SessionRuntime.tsx`);
> the thread reads the SDK's stores and sends through the SDK's functions.
> `lib/session/sdk-boundary.test.ts` fails when source hand-builds a runtime
> route or imports an OpenCode-named SDK symbol.
>
> New data or runtime behaviour goes into `packages/sdk`, not into this app.

## Local development

See the repo root `AGENTS.md` / `CLAUDE.md` for the full local stack. Mobile runs
against the local API in the iOS simulator; expect setup friction while this app
is parked.
