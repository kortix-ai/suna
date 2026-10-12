// Disposable caches (composer drafts, the persisted query cache) register in
// the SDK module's registry. Quota reclaim and the boot prune only see them
// through the same instance. See CANONICAL_SDK_ENTRIES in
// scripts/sdk-boundary.mjs.
export * from '@kortix/sdk/internal/managed-storage'; // eslint-disable-line no-restricted-imports
