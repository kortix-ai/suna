/**
 * `core/auth` — the optional token PRODUCER.
 *
 * Isomorphic-core tier and reachable from the canonical root entry
 * (`@kortix/sdk`), exactly like `core/files` and `core/turns`. There is
 * deliberately NO new subpath: the module is framework-free, so a subpath
 * would buy nothing and cost a permanent public path. A future
 * `useKortixAuth()` belongs in the existing `./react` key, and a future
 * cookie/SSR adapter in the existing `./server` key.
 *
 * This barrel is EXPLICIT, not `export *`: the GoTrue call layer, the storage
 * blob codec, and the base64 helpers are implementation detail, and surface
 * you never shipped is surface you never have to support.
 */

export {
  createKortixAuth,
  type KortixAuth,
  type KortixAuthChange,
  type KortixAuthEvent,
  type KortixAuthOptions,
} from './client';
export { fetchKortixAuthConfig, type KortixAuthConfig, type KortixAuthMethod } from './config';
export { KortixAuthError } from './errors';
export type { KortixVerifyOtpType } from './gotrue';
export type { KortixAuthSession, KortixAuthUser } from './session';
export {
  createLocalStorageAuthStorage,
  createMemoryAuthStorage,
  type KortixAuthStorage,
} from './storage';
