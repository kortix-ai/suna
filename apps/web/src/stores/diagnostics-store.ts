// The SDK event stream writes LSP diagnostics into this store, so the web app
// must read the same instance. A local copy would be a second, never-written
// store. See CANONICAL_SDK_ENTRIES in scripts/sdk-boundary.mjs.
import { useDiagnosticsStore } from '@kortix/sdk/internal/diagnostics-store'; // eslint-disable-line no-restricted-imports

import { registerPersistedStore, resetPersistedStore } from '@/stores/persisted-store-registry';

export * from '@kortix/sdk/internal/diagnostics-store'; // eslint-disable-line no-restricted-imports

// Sign-out resets the SDK store through the web registry, without
// `reset-client-state.ts` importing this file. See `persisted-store-registry.ts`.
registerPersistedStore('kortix-diagnostics', () => resetPersistedStore(useDiagnosticsStore));
