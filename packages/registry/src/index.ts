/**
 * @kortix/registry — the Kortix registry + marketplace engine.
 *
 * A shadcn-compatible registry format plus the primitives to turn any Kortix
 * repo into a registry (`buildRegistry`), resolve an item from GitHub / a URL /
 * disk (`loadItem`), plan an install with transitive dependencies
 * (`planInstall`), and apply it while tracking a lock file (`applyInstall`).
 *
 * The `kortix` CLI uses this today (`kortix add`, `kortix registry`); the API
 * and the web marketplace are intended to build on the very same engine.
 */

export * from './schema';
export * from './validate';
export * from './address';
export * from './manifest';
export * from './paths';
export * from './skills';
export * from './fetch';
export * from './build';
export * from './lock';
export * from './install';
export * from './status';
