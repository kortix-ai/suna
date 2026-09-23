import { describe, expect, test } from 'bun:test'
import type { Config } from '../config'
import type { HarnessControlOperations, HarnessEnvironmentInput, HarnessEnvironmentResult } from '../harness/control'
import { KORTIX_USER_CONTEXT_HEADER } from '../kortix-user-context'
import { createEnvRouter } from '../routes/env'

const cfg = { sandboxToken: 'control-boundary-token' } as Config
const applied: HarnessEnvironmentResult = {
  ok: true,
  changed: false,
  revision: 'rev-1',
  names: [],
  exported: 0,
  managed: 0,
  withheld: 0,
  agent_env_written: true,
  egress_shim: 'unchanged',
  egress_shim_hosts: [],
  opencode_env_changed: false,
  opencode_env_names: [],
  opencode: 'ok',
  opencode_pid: 123,
  opencode_reload: null,
  opencode_turn_ended: null,
}

function fixture() {
  const calls: HarnessEnvironmentInput[] = []
  const control: HarnessControlOperations = {
    applyEnvironment: async (input) => { calls.push(input); return applied },
    refresh: async () => { throw new Error('unexpected refresh') },
    abort: async () => { throw new Error('unexpected abort') },
    armAbortAfterTool: async () => { throw new Error('unexpected arm') },
    disarmAbortAfterTool: () => { throw new Error('unexpected disarm') },
  }
  return { router: createEnvRouter(cfg, control), calls }
}

const headers = {
  Authorization: `Bearer ${cfg.sandboxToken}`,
  'Content-Type': 'application/json',
}

describe('env controller control boundary', () => {
  test('rejects unauthorized, proxied and malformed requests before invoking control operations', async () => {
    const { router, calls } = fixture()
    const body = JSON.stringify({ revision: 'rev-1', env: {} })
    expect((await router.request('/', { method: 'POST', body })).status).toBe(401)
    expect((await router.request('/', {
      method: 'POST', body, headers: { ...headers, [KORTIX_USER_CONTEXT_HEADER]: 'present' },
    })).status).toBe(403)
    const invalid = await router.request('/', { method: 'POST', headers, body: '{}' })
    expect(invalid.status).toBe(400)
    expect(await invalid.json()).toEqual({ error: 'revision is required' })
    expect(calls).toEqual([])
  })

  test('holds the per-router lock while the request body is still arriving, then releases it', async () => {
    const { router, calls } = fixture()
    let stream!: ReadableStreamDefaultController<Uint8Array>
    let reading!: () => void
    const bodyRead = new Promise<void>((resolve) => { reading = resolve })
    const body = new ReadableStream<Uint8Array>({
      start(controller) { stream = controller },
      pull() { reading() },
    })
    const first = router.request(new Request('http://localhost/', {
      method: 'POST', headers, body, duplex: 'half',
    } as RequestInit))
    await bodyRead

    const payload = JSON.stringify({ revision: 'rev-1', env: {}, opencodeEnv: { MODEL_SETTING: 'value' } })
    try {
      const second = await router.request('/', { method: 'POST', headers, body: payload })
      expect(second.status).toBe(409)
      expect(await second.json()).toEqual({ error: 'env sync already running' })
      expect(calls).toEqual([])
    } finally {
      stream.enqueue(new TextEncoder().encode(payload))
      stream.close()
    }

    const response = await first
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(applied)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.runtimeEnv).toEqual({ MODEL_SETTING: 'value' })
    expect((await router.request('/', { method: 'POST', headers, body: payload })).status).toBe(200)
    expect(calls).toHaveLength(2)
  })
})
