import { expect, test, spyOn } from 'bun:test'
import type { Config } from '../config'
import type { Opencode } from '../opencode'
import { startProxy } from '../proxy'
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


test('stopping the proxy cancels offload timers and makes queued callbacks inert', async () => {
  const callbacks: Array<() => void> = []
  const timer = { unref() {} } as unknown as ReturnType<typeof setTimeout>
  const originalTimeout = globalThis.setTimeout
  const originalInterval = globalThis.setInterval
  const timeout = spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void, ms: number, ...args: unknown[]) => {
    if (ms === 90_000) { callbacks.push(callback); return timer }
    return originalTimeout(callback, ms, ...args)
  }) as typeof setTimeout)
  const interval = spyOn(globalThis, 'setInterval').mockImplementation(((callback: () => void, ms: number, ...args: unknown[]) => {
    if (ms === 300_000) { callbacks.push(callback); return timer }
    return originalInterval(callback, ms, ...args)
  }) as typeof setInterval)
  const clearBoot = spyOn(globalThis, 'clearTimeout')
  const clearRepeat = spyOn(globalThis, 'clearInterval')
  const previous = process.env.KORTIX_ATTACHMENT_OFFLOAD
  process.env.KORTIX_ATTACHMENT_OFFLOAD = '1'
  let reachedRuntime = 0
  const opencode = {
    getState: () => 'ok', getPid: () => null,
    getInternalUrl: () => { reachedRuntime++; throw new Error('test prevents access to any transcript') },
  } as unknown as Opencode
  let proxy: ReturnType<typeof startProxy> | undefined
  try {
    proxy = startProxy(baseConfig(), opencode, Date.now())
    await proxy.stop()
    expect(callbacks).toHaveLength(2)
    expect(clearBoot).toHaveBeenCalledWith(timer)
    expect(clearRepeat).toHaveBeenCalledWith(timer)
    reachedRuntime = 0
    for (const callback of callbacks) callback()
    await Promise.resolve()
    expect(reachedRuntime).toBe(0)
  } finally {
    await proxy?.stop()
    timeout.mockRestore(); interval.mockRestore(); clearBoot.mockRestore(); clearRepeat.mockRestore()
    if (previous === undefined) delete process.env.KORTIX_ATTACHMENT_OFFLOAD
    else process.env.KORTIX_ATTACHMENT_OFFLOAD = previous
  }
})
