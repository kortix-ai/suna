import { expect, test, spyOn } from 'bun:test'
import type { OpenCodeConfig as Config } from '../harness/open-code/config'
import type { Opencode } from '../harness/open-code/lifecycle'
import { startProxy } from '../proxy'
import { requireOpenCodeConfig } from '../harness/open-code/config'
import { composeOpenCodeHarnessService } from '../harness/open-code/service'
const TEST_TOKEN = 'test-kortix-token-32-chars-1234567890'

function baseConfig(over: Partial<Config> = {}): Config {
  return {
    servicePort: 0,
    opencodeInternalPort: 4096,
    opencodeStandbyPort: 4097,
    staticPort: 3211,
    workspace: '/tmp',
    projectTarget: '/tmp',
    defaultBranch: 'main',
    branchFetchAttempts: 60,
    branchFetchDelaySec: 0.25,
    defaultOpencodeConfigDir: '/ephemeral/opencode',
    autoClone: false,
    projectId: undefined,
    apiUrl: undefined,
    repoUrl: undefined,
    branchName: undefined,
    sessionFresh: false,
    baseSha: undefined,
    sandboxToken: TEST_TOKEN,
    gitUserName: 'Kortix Agent',
    gitUserEmail: 'agent@kortix.ai',
    cloneFilter: '',
    compiledBootMode: 'off',
    cloneDepth: 1,
    workload: '',
    monitorsJson: '',
    monitorBoxEpoch: '',
    ...over,
  }
}


test('after stop, no timer the proxy scheduled reaches the runtime', async () => {
  // Capture every timer the daemon schedules while it starts, whatever its
  // cadence, then fire them all after stop: a queued offload pass (or any
  // other background job) must be inert once the proxy is stopped.
  const callbacks: Array<() => void> = []
  const timer = { unref() {}, ref() {} } as unknown as ReturnType<typeof setTimeout>
  const capture = ((callback: () => void) => {
    callbacks.push(callback)
    return timer
  }) as unknown as typeof setTimeout
  const previous = process.env.KORTIX_ATTACHMENT_OFFLOAD
  process.env.KORTIX_ATTACHMENT_OFFLOAD = '1'
  let reachedRuntime = 0
  const opencode = {
    getState: () => 'ok', getPid: () => null,
    getInternalUrl: () => { reachedRuntime++; throw new Error('test prevents access to any transcript') },
  } as unknown as Opencode
  let proxy: ReturnType<typeof startProxy> | undefined
  const timeout = spyOn(globalThis, 'setTimeout').mockImplementation(capture)
  const interval = spyOn(globalThis, 'setInterval').mockImplementation(capture as unknown as typeof setInterval)
  try {
    const cfg = baseConfig()
    proxy = startProxy(cfg, composeOpenCodeHarnessService(requireOpenCodeConfig(cfg), opencode), Date.now())
  } finally {
    timeout.mockRestore()
    interval.mockRestore()
  }
  try {
    expect(callbacks.length).toBeGreaterThan(0)
    await proxy.stop()
    reachedRuntime = 0
    for (const callback of callbacks) {
      try {
        callback()
      } catch {}
    }
    await Bun.sleep(10)
    expect(reachedRuntime).toBe(0)
  } finally {
    await proxy?.stop()
    if (previous === undefined) delete process.env.KORTIX_ATTACHMENT_OFFLOAD
    else process.env.KORTIX_ATTACHMENT_OFFLOAD = previous
  }
})
