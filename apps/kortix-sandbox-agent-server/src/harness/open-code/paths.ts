import { homedir } from 'node:os'

/** Native paths are leaf dependencies; they must not initialize the lifecycle. */
export const OPENCODE_HOME = homedir()
