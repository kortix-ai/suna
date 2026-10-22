---
recorded: 2026-09-29T01:58:54Z
incident_date: 2026-09-29
---
# Mock AsyncStorage in mobile store tests only through the shared in-memory module

**Rule:** In `apps/mobile`, import `stores/in-memory-async-storage.ts` for AsyncStorage in every store test. Never call `mock.module('@react-native-async-storage/async-storage', …)` in a test file. Bun runs all test files in one module registry, and zustand `persist` keeps the storage object it was created with, so a second mock with its own Map breaks whichever file imports the store later.

**Trigger surface:** Writing or editing a mobile test that imports a persisted zustand store.

**Incident:** 2026-09-29. PR #8031 added `tool-preview-store.test.ts` with its own mock and imported `tab-store` under it. When bun ran it first, 2 `tab-store.test.ts` cases read an empty Map and the packages lane failed (run for 9700992a6f). File order varies, so the failure was intermittent.

**Enforcement:** `apps/mobile/stores/in-memory-async-storage.test.ts` fails when any other mobile file registers an AsyncStorage mock.
