// The SDK registers its own disposable caches (sessions, agents, commands,
// providers) in this module's registry. Quota reclaim and the boot
// prune only see them through the same instance. See CANONICAL_SDK_ENTRIES in
// scripts/sdk-boundary.mjs.
export * from '@kortix/sdk/internal/managed-storage'; // eslint-disable-line no-restricted-imports
