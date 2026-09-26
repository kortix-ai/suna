// The SDK event stream writes LSP diagnostics into this store, so the web app
// must read the same instance. A local copy would be a second, never-written
// store. The SDK resets it on identity change (`resetIdentityState`). See
// CANONICAL_SDK_ENTRIES in scripts/sdk-boundary.mjs.
export * from '@kortix/sdk/internal/diagnostics-store'; // eslint-disable-line no-restricted-imports
