import type { Opencode } from './opencode'

export function createExecutionOnlyRuntime(): Opencode {
  const unavailable = (): never => {
    throw new Error('This environment executes workspace tools. Its agent runtime runs in the worker.')
  }
  return {
    prefetchBinary: async () => false,
    cancelBinaryPrefetch() {},
    start: unavailable,
    stop: async () => {},
    restart: unavailable,
    reloadConfig: unavailable,
    reloadForWorkspace: unavailable,
    markWorkspaceReady() {},
    reloadVerified: unavailable,
    reconfigure: unavailable,
    getPid: () => null,
    getInternalUrl: unavailable,
    getActivePort: () => 0,
    getBinaryPath: () => null,
    getState: () => 'down',
    markReady: unavailable,
    waitForCurrentReadyResponse: unavailable,
  }
}
