/** Provider-neutral sandbox daemon operations. Agent conversations use ACP. */
export { listEnv, setEnv, deleteEnv, env } from '../opencode/env';
export { triggersRequest } from '../opencode/triggers';
export * from '../opencode/kortix-master';
// Non-conversation daemon APIs (files, git, PTY, provider setup) still share
// the generated daemon transport while conversations move through ACP.
// Keep that transport behind this provider-neutral runtime boundary.
export { getClient as getRuntimeClient } from '../opencode/client';
