/** Provider-neutral sandbox daemon operations. Agent conversations use ACP. */
export { listEnv, setEnv, deleteEnv, env } from '../opencode/env';
export { triggersRequest } from '../opencode/triggers';
export * from '../opencode/kortix-master';
// Non-conversation daemon APIs (files, git, PTY, provider setup) still share
// the generated daemon transport while conversations move through ACP.
// Keep that transport behind this provider-neutral runtime boundary.
export {
  dropClientForUrl as dropRuntimeClientForUrl,
  dropPublicClientForUrl as dropPublicRuntimeClientForUrl,
  getClient as getRuntimeClient,
  getClientForUrl as getRuntimeClientForUrl,
  getPublicClientForUrl as getPublicRuntimeClientForUrl,
  resetClient as resetRuntimeClient,
  resetPublicClient as resetPublicRuntimeClient,
  systemReload,
  type OpencodeClient as RuntimeClient,
  type SystemReloadMode,
  type SystemReloadResult,
} from '../opencode/client';
export type * from './wire-types';
