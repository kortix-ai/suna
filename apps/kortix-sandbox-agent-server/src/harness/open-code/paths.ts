import { homedir } from 'node:os'

/** Native paths are leaf dependencies; they must not initialize the supervisor. */
export const OPENCODE_HOME = homedir()
