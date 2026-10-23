import { homedir } from 'node:os'

/**
 * Native paths are leaf dependencies; they must not initialize the lifecycle.
 * @deprecated OpenCode is sunset: no new code. See harness/README.md "OpenCode sunset".
 */
export const OPENCODE_HOME = homedir()
