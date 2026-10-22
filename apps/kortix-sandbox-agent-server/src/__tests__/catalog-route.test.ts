import { describe, expect, test } from 'bun:test'
import type { Config } from '@/lib/config/config'
import type { HarnessControlOperations } from '@/harness/contract/control'
import { createCatalogRouter } from '@/routes/kortix/catalog'

describe('POST /kortix/catalog/converge', () => {
  const asked: Array<{ model?: string } | undefined> = []
  const control = {
    convergeCatalog: async (options?: { model?: string }) => {
      asked.push(options)
      return { ok: true, outcome: 'unchanged', missing: [], managed: 0, reason: null, model_present: true }
    },
  } as unknown as HarnessControlOperations
  const router = createCatalogRouter({ sandboxToken: 'svc' } as Config, control)
  const post = (body?: string) =>
    router.request('/converge', {
      method: 'POST',
      headers: { Authorization: 'Bearer svc', 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body }),
    })

  test('passes one well-formed model id through, and nothing otherwise', async () => {
    asked.length = 0
    expect((await post(JSON.stringify({ model: 'codex/gpt-6.1-sol' }))).status).toBe(200)
    await post()
    await post(JSON.stringify({ model: '../../etc/passwd x' }))
    await post(JSON.stringify({ model: 42 }))
    await post('not json')
    expect(asked).toEqual([{ model: 'codex/gpt-6.1-sol' }, undefined, undefined, undefined, undefined])
  })

  test('refuses a caller without the service token', async () => {
    const res = await router.request('/converge', { method: 'POST' })
    expect(res.status).toBe(401)
  })
})
