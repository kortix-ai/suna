/**
 * The runtime routes a daemon built before W5 E4 serves: OpenCode's REST
 * spellings (`prompt_async`, `?directory=`, `/agent`). The session lifecycle
 * sends them only to a daemon that does not list `runtime.turns.v1`
 * (`runtimeServesTurnVerbs`); every newer daemon gets the Kortix routes in
 * `runtimeVerbPaths` (runtime-fetch.ts). Delete this file when no such daemon
 * runs.
 */

import { WORKSPACE } from './runtime-fetch';

const segment = encodeURIComponent;
const inWorkspace = (directory: string = WORKSPACE) => `?directory=${segment(directory)}`;

export const legacyRuntimePaths = {
  /** The transcript, oldest first; the newest `limit` when given. */
  messages: (sessionId: string, limit?: number) =>
    `/session/${segment(sessionId)}/message${inWorkspace()}${limit === undefined ? '' : `&limit=${limit}`}`,
  message: (sessionId: string, messageId: string) =>
    `/session/${segment(sessionId)}/message/${segment(messageId)}${inWorkspace()}`,
  /** One part of a message; OpenCode-only (pi has no part edits). */
  part: (sessionId: string, messageId: string, partId: string) =>
    `/session/${segment(sessionId)}/message/${segment(messageId)}/part/${segment(partId)}${inWorkspace()}`,
  /** The session row; `revert` is its staged rewind. */
  session: (sessionId: string) => `/session/${segment(sessionId)}${inWorkspace()}`,
  abort: (sessionId: string) => `/session/${segment(sessionId)}/abort${inWorkspace()}`,
  agents: (directory: string) => `/agent${inWorkspace(directory)}`,
  /** Path and query of the prompt POST, split for `forwardToSandbox`. */
  prompt: (sessionId: string, directory?: string) => ({
    path: `/session/${segment(sessionId)}/prompt_async`,
    query: inWorkspace(directory || WORKSPACE),
  }),
} as const;
