import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { HarnessTurnService, RuntimePromptInput } from '@/harness/contract/turns'
import { createRuntimeRouter, parseRuntimePromptBody } from '@/routes/kortix/runtime'
import { syncMemoryCopy, type MemoryLayerRef } from '@/services/tools/memory-copy'

/**
 * The read-only memory copy (services/memory-copy.ts): the API's layer export
 * becomes `<root>/<dir>/`, replaced whole when the layer version changes.
 * The API is a fake `fetch`; the folder is a temp root.
 */
const ENV = { KORTIX_API_URL: 'https://api.test', KORTIX_PROJECT_ID: 'proj-1', KORTIX_TOKEN: 'kortix_sb_test' }
const CHANNEL: MemoryLayerRef = { layer_id: 'layer-1', version: '7', dir: 'channel' }

const EXPORT = {
  layer_id: 'layer-1',
  version: 7,
  dir: 'channel',
  index: '# #marketing\n\n## People\n- Priya — runs the Q4 launch (people/priya.md)\n',
  pages: [
    { page_id: 'p1', type: 'people', slug: 'priya', markdown: '---\ntitle: "Priya"\n---\nRuns the Q4 launch [Thread]\n' },
    { page_id: 'p2', type: 'note', slug: 'call-northwind', markdown: '---\ntitle: "Call Northwind"\n---\nCall Northwind on Monday\n' },
  ],
}

let root: string
let calls: Array<{ url: string; auth: string | null }>

/** A fake API: answers `reply` and records each call. */
const api = (reply: () => Response | Promise<Response>): typeof fetch =>
  (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), auth: new Headers(init?.headers).get('authorization') })
    return reply()
  }) as typeof fetch

/** Every file under `dir`, relative path → text. */
function tree(dir: string, prefix = ''): Record<string, string> {
  const out: Record<string, string> = {}
  for (const entry of readdirSync(join(dir, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) Object.assign(out, tree(dir, path))
    else out[path] = readFileSync(join(dir, path), 'utf8')
  }
  return out
}

const unlockAll = (dir: string) => {
  try {
    chmodSync(dir, 0o755)
    for (const entry of readdirSync(dir, { withFileTypes: true })) if (entry.isDirectory()) unlockAll(join(dir, entry.name))
  } catch {}
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'memory-copy-'))
  calls = []
})
afterEach(() => {
  unlockAll(root)
  rmSync(root, { recursive: true, force: true })
})

describe('syncMemoryCopy', () => {
  test('a new version replaces the folder whole: INDEX.md, one file per page under its type folder, .version, all read-only', async () => {
    await syncMemoryCopy([CHANNEL], ENV, { root, fetch: api(() => Response.json(EXPORT)) })
    expect(calls).toEqual([{ url: 'https://api.test/v1/projects/proj-1/memory/layers/layer-1/export', auth: 'Bearer kortix_sb_test' }])
    expect(tree(join(root, 'channel'))).toEqual({
      '.version': '7',
      'INDEX.md': EXPORT.index,
      'notes/call-northwind.md': EXPORT.pages[1]!.markdown,
      'people/priya.md': EXPORT.pages[0]!.markdown,
    })
    expect(statSync(join(root, 'channel')).mode & 0o777).toBe(0o555)
    expect(statSync(join(root, 'channel/people')).mode & 0o777).toBe(0o555)
    expect(statSync(join(root, 'channel/people/priya.md')).mode & 0o777).toBe(0o444)

    // The next version drops a page: the old file is gone, no temp folder is left.
    const next = { ...EXPORT, version: 8, pages: [EXPORT.pages[0]] }
    await syncMemoryCopy([{ ...CHANNEL, version: '8' }], ENV, { root, fetch: api(() => Response.json(next)) })
    expect(Object.keys(tree(join(root, 'channel'))).sort()).toEqual(['.version', 'INDEX.md', 'people/priya.md'])
    expect(readFileSync(join(root, 'channel/.version'), 'utf8')).toBe('8')
    expect(readdirSync(root)).toEqual(['channel'])
  })

  test('a folder already at the version is not fetched', async () => {
    await syncMemoryCopy([CHANNEL], ENV, { root, fetch: api(() => Response.json(EXPORT)) })
    await syncMemoryCopy([CHANNEL], ENV, { root, fetch: api(() => Response.json(EXPORT)) })
    expect(calls).toHaveLength(1)
  })

  test('the layers sync at once, each in its own folder; an API base that ends in /v1 is kept', async () => {
    const company: MemoryLayerRef = { layer_id: 'layer-0', version: '3', dir: 'company' }
    await syncMemoryCopy([company, CHANNEL], { ...ENV, KORTIX_API_URL: 'https://api.test/v1/' }, {
      root,
      fetch: api(() => Response.json(EXPORT)),
    })
    expect(calls.map((call) => call.url).sort()).toEqual([
      'https://api.test/v1/projects/proj-1/memory/layers/layer-0/export',
      'https://api.test/v1/projects/proj-1/memory/layers/layer-1/export',
    ])
    expect(readdirSync(root).sort()).toEqual(['channel', 'company'])
  })

  test('an unsafe slug, type or folder writes nothing and keeps the old copy', async () => {
    await syncMemoryCopy([CHANNEL], ENV, { root, fetch: api(() => Response.json(EXPORT)) })
    const before = tree(join(root, 'channel'))
    for (const page of [
      { type: 'people', slug: '../../etc/passwd', markdown: 'x' },
      { type: 'people', slug: 'Priya', markdown: 'x' },
      { type: 'people', slug: 'a/b', markdown: 'x' },
      { type: '../people', slug: 'priya', markdown: 'x' },
    ]) {
      await syncMemoryCopy([{ ...CHANNEL, version: '8' }], ENV, { root, fetch: api(() => Response.json({ ...EXPORT, version: 8, pages: [page] })) })
      expect(tree(join(root, 'channel'))).toEqual(before)
    }
    await syncMemoryCopy([{ ...CHANNEL, dir: '../x' as never }], ENV, { root, fetch: api(() => Response.json(EXPORT)) })
    expect(readdirSync(root)).toEqual(['channel'])
  })

  test('a fetch past the time cap, an error status, or no token leaves the old copy', async () => {
    await syncMemoryCopy([CHANNEL], ENV, { root, fetch: api(() => Response.json(EXPORT)) })
    const before = tree(join(root, 'channel'))
    const never = (async (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason)))) as unknown as typeof fetch
    await syncMemoryCopy([{ ...CHANNEL, version: '8' }], ENV, { root, fetch: never, timeoutMs: 5 })
    await syncMemoryCopy([{ ...CHANNEL, version: '8' }], ENV, { root, fetch: api(() => Response.json({ error: 'nope', code: 'memory_not_found' }, { status: 404 })) })
    await syncMemoryCopy([{ ...CHANNEL, version: '8' }], { ...ENV, KORTIX_TOKEN: '' }, { root, fetch: api(() => Response.json(EXPORT)) })
    expect(tree(join(root, 'channel'))).toEqual(before)
    expect(readdirSync(root)).toEqual(['channel'])
  })
})

describe('the Kortix prompt route', () => {
  test('memory_layers parse to memoryLayers; a malformed entry is refused; none leaves the input as before', () => {
    const parts = [{ type: 'text', text: 'hi' }]
    expect(parseRuntimePromptBody({ parts, memory_layers: [{ layer_id: 'layer-1', version: 7, dir: 'channel' }, { layer_id: 'layer-0', version: '12', dir: 'company' }] })).toEqual({
      parts,
      memoryLayers: [{ layer_id: 'layer-1', version: '7', dir: 'channel' }, { layer_id: 'layer-0', version: '12', dir: 'company' }],
    })
    expect(parseRuntimePromptBody({ parts, memory_layers: [] })).toEqual({ parts })
    expect(parseRuntimePromptBody({ parts })).toEqual({ parts })
    const error = 'memory_layers must be [{ layer_id, version, dir: company | channel | personal }]'
    for (const memory_layers of [{}, [null], [{ layer_id: '', version: 1, dir: 'channel' }], [{ layer_id: 'l', version: 1.5, dir: 'channel' }], [{ layer_id: 'l', version: '1a', dir: 'channel' }], [{ layer_id: 'l', version: 1, dir: '../etc' }]]) {
      expect(parseRuntimePromptBody({ parts, memory_layers })).toBe(error)
    }
  })

  test('the copy is synced before the turn starts; a no_reply message syncs nothing', async () => {
    const order: string[] = []
    const turns = {
      prompt: async (_id: string, input: RuntimePromptInput) => {
        order.push(`prompt ${input.messageId}`)
        return { status: 202, body: { message_id: input.messageId } }
      },
    } as unknown as HarnessTurnService
    const app = createRuntimeRouter({ sandboxToken: 'tok' } as Parameters<typeof createRuntimeRouter>[0], {} as Parameters<typeof createRuntimeRouter>[1], {
      turns,
      syncMemory: async (layers) => {
        await Bun.sleep(0)
        order.push(`sync ${layers.map((layer) => `${layer.dir}@${layer.version}`).join(',')}`)
      },
    })
    const post = (body: Record<string, unknown>) =>
      app.request('/sessions/ses_1/prompt', { method: 'POST', headers: { Authorization: 'Bearer tok', 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const parts = [{ type: 'text', text: 'hi' }]
    expect((await post({ message_id: 'msg_1', parts, memory_layers: [{ layer_id: 'layer-1', version: 7, dir: 'channel' }] })).status).toBe(202)
    expect((await post({ message_id: 'msg_2', parts, no_reply: true, memory_layers: [{ layer_id: 'layer-1', version: 8, dir: 'channel' }] })).status).toBe(202)
    expect((await post({ message_id: 'msg_3', parts })).status).toBe(202)
    expect(order).toEqual(['sync channel@7', 'prompt msg_1', 'prompt msg_2', 'prompt msg_3'])
  })
})
