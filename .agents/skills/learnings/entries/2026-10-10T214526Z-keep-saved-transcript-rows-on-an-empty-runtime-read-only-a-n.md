---
recorded: 2026-10-10T21:45:26Z
incident_date: 2026-10-10
supersedes: 2026-09-26T202929Z-keep-only-a-server-captured-transcript-on-a-device-never-the.md
---
# Keep saved transcript rows on an empty runtime read; only a non-empty read settles them

**Rule:** An empty runtime read for the saved root is lost box state, not an empty conversation, whichever read lands first. It drops nothing: provisional saved rows (`source: 'cache'`) and their parts stay, still provisional. It blocks nothing: a saved copy that arrives after it still paints. Only a non-empty runtime read settles the saved rows (by value: it confirms the ids it contains and drops the ones it covers but lacks) and keeps a later saved copy out. This changes the superseded entry's "let the first runtime read drop what it covers and lacks" for the empty read only. Its other rules stay: keep only server envelopes on a device, never the live store, and a stopped turn never paints as running.

**Trigger surface:** Changing `hydrate` in `packages/sdk/src/browser/stores/sync-store.ts` (the `cacheSourcedIds` settle), `shouldHydrateFromMirror`, the saved-copy paint effect in `useSessionSync`, or any code that treats an empty runtime transcript as proof of an empty conversation.

**Incident:** Found 2026-10-10 in the Session Log Plan review (P0.4). `hydrate` dropped every provisional saved row on an empty runtime read, and an empty read that landed first made `useSessionSync` refuse the saved copy. A session whose box lost its state (a recreated sandbox, a wiped harness store) showed an empty conversation in either order. Mobile renders through the same SDK hook, so both hosts blanked.

**Enforcement:** `packages/sdk/src/browser/session-sync/server-transcript-mirror.test.ts` ("an empty live transcript keeps every provisional saved message"; "an empty live read is not authoritative: late saved history still paints"), `packages/sdk/src/browser/stores/sync-store.test.ts` ("an empty runtime page keeps cached rows and their parts, still provisional"), and `packages/sdk/src/react/use-session-sync-saved-copy.test.ts` (an empty read first, or a saved copy arriving after it, still paints; a read with messages keeps it out). The superseded entry's three SDK enforcers stay green; its mobile test was deleted with mobile's own store in PR #8699.
