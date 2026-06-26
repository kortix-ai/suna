/**
 * @kortix/sdk — the Kortix frontend data layer, in one package.
 *
 * Configure once at startup, then use the React hooks (`@kortix/sdk/react`) or
 * the data modules (subpath imports below). Every host — web, mobile, demo —
 * shares this single implementation; nothing talks to the raw API or OpenCode.
 *
 * The data modules are exposed as subpaths (not merged here) to keep the
 * surface collision-free and tree-shakeable:
 *   @kortix/sdk/react            — all useOpenCode* hooks + providers
 *   @kortix/sdk/opencode-client  — the scoped OpenCode v2 client factory
 *   @kortix/sdk/auth             — authenticatedFetch + token accessors
 *   @kortix/sdk/api-client       — backendApi (typed REST)
 *   @kortix/sdk/projects-client  — project/session REST surface
 *   @kortix/sdk/server-store     — active sandbox/server state
 *   @kortix/sdk/sync-store       — live message/part/status store
 */
export {
  configureKortix,
  platformConfig,
  isConfigured,
  type KortixPlatformConfig,
} from './platform/config';

/**
 * The opinionated single entry point. `createKortix({ getToken })` wires the
 * platform seam and returns one client whose methods cover the whole REST +
 * opencode surface — so a host app imports ONLY from `@kortix/sdk`.
 */
export { createKortix, type Kortix } from './kortix';

/** Workspace file operations (daemon `/file` + `/find`), owned by the SDK. */
export { files } from './files/client';
export type * from './files/types';
