---
recorded: 2026-09-26T20:29:29Z
incident_date: 2026-08-24
---
# Keep only a server-captured transcript on a device, never the live store, and hold it provisional until a runtime read

**Rule:** A transcript kept on a device (web `localStorage`, mobile AsyncStorage) is only an envelope the server sent: the mirror the API writes because a turn ended, with OpenCode's `info` verbatim and its root id. Never persist the live store. Paint a kept copy with `source: 'cache'` for its own root only, and let the first runtime read drop what it covers and lacks.

**Trigger surface:** Painting a transcript before the computer answers, on any host; changing `createSavedCopyStore`, `useSessionSync`'s saved-copy paint, or mobile's `lib/session/saved-copy.ts` or `sync-store.ts` `hydrate`.

**Incident:** 2026-08-24. An IndexedDB mirror of the live store (#5837) decided when to write from the transcript's shape. A Stop stamps `error` and adds no part, so the disk copy of a stopped turn had no end: the next cold paint showed it running and dimmed later messages to "Queued". Removed in `5a7a43517f`. The replacement kept on the device in PR #7778 stores server captures only.

**Enforcement:** `packages/sdk/src/browser/cache/no-transcript-mirror.test.ts` (the live path never imports the IndexedDB mirror); `packages/sdk/src/core/session-sync/saved-copy-store.test.ts` (only a paintable server envelope is kept); `packages/sdk/src/react/use-session-sync-local-copy.test.ts` (root guard, no paint over a runtime read); `apps/mobile/lib/opencode/sync-store.test.ts` ("a saved copy is provisional until the runtime reads").
