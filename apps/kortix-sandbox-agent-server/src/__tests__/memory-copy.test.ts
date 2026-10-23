import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
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
  /** `.version`: the layer version, then the hash of the other files. */
  const version = (dir = 'channel') => readFileSync(join(root, dir, '.version'), 'utf8')
  const pages = (dir = 'channel') => Object.fromEntries(Object.entries(tree(join(root, dir))).filter(([path]) => path !== '.version'))

  test('a new version replaces the folder whole: INDEX.md, one file per page under its type folder, .version, all read-only', async () => {
    await syncMemoryCopy([CHANNEL], ENV, { root, fetch: api(() => Response.json(EXPORT)) })
    expect(calls).toEqual([{ url: 'https://api.test/v1/projects/proj-1/memory/layers/layer-1/export', auth: 'Bearer kortix_sb_test' }])
    expect(pages()).toEqual({
      'INDEX.md': EXPORT.index,
      'notes/call-northwind.md': EXPORT.pages[1]!.markdown,
      'people/priya.md': EXPORT.pages[0]!.markdown,
    })
    expect(version()).toMatch(/^7\n[0-9a-f]{64}\n$/)
    expect(statSync(join(root, 'channel')).mode & 0o777).toBe(0o555)
    expect(statSync(join(root, 'channel/people')).mode & 0o777).toBe(0o555)
    expect(statSync(join(root, 'channel/people/priya.md')).mode & 0o777).toBe(0o444)

    // The next version drops a page: the old file is gone, no temp folder is left.
    const next = { ...EXPORT, version: 8, pages: [EXPORT.pages[0]] }
    await syncMemoryCopy([{ ...CHANNEL, version: '8' }], ENV, { root, fetch: api(() => Response.json(next)) })
    expect(Object.keys(pages()).sort()).toEqual(['INDEX.md', 'people/priya.md'])
    expect(version()).toStartWith('8\n')
    expect(readdirSync(root)).toEqual(['channel'])
  })

  test('a folder already at the version, with untouched files, is not fetched', async () => {
    await syncMemoryCopy([CHANNEL], ENV, { root, fetch: api(() => Response.json(EXPORT)) })
    await syncMemoryCopy([CHANNEL], ENV, { root, fetch: api(() => Response.json(EXPORT)) })
    expect(calls).toHaveLength(1)
  })

  test('a local edit, an added file or an edited .version is overwritten at the next sync of the same version', async () => {
    await syncMemoryCopy([CHANNEL], ENV, { root, fetch: api(() => Response.json(EXPORT)) })
    const clean = tree(join(root, 'channel'))
    const unlock = () => {
      chmodSync(join(root, 'channel'), 0o755)
      chmodSync(join(root, 'channel/people'), 0o755)
      chmodSync(join(root, 'channel/people/priya.md'), 0o644)
    }
    const edits: Array<() => void> = [
      () => writeFileSync(join(root, 'channel/people/priya.md'), 'Priya left the company.\n'),
      () => writeFileSync(join(root, 'channel/people/eve.md'), 'Eve owns the budget.\n'),
      () => {
        writeFileSync(join(root, 'channel/people/priya.md'), 'Priya left the company.\n')
        chmodSync(join(root, 'channel/.version'), 0o644)
        writeFileSync(join(root, 'channel/.version'), `7\n${'0'.repeat(64)}\n`)
      },
    ]
    for (const edit of edits) {
      unlock()
      edit()
      await syncMemoryCopy([CHANNEL], ENV, { root, fetch: api(() => Response.json(EXPORT)) })
      expect(tree(join(root, 'channel'))).toEqual(clean)
    }
    expect(calls).toHaveLength(4)
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

  test('a page with an unsafe or repeated file name is skipped; the rest of the layer is written', async () => {
    const bad = [
      { type: 'people', slug: '../../etc/passwd', markdown: 'x' },
      { type: 'people', slug: 'Priya', markdown: 'x' },
      { type: 'people', slug: 'a/b', markdown: 'x' },
      { type: 'people', slug: '', markdown: 'x' },
      { type: '../people', slug: 'priya', markdown: 'x' },
      { type: 'people', slug: 'priya', markdown: 'a second Priya' },
    ]
    await syncMemoryCopy([CHANNEL], ENV, { root, fetch: api(() => Response.json({ ...EXPORT, pages: [...EXPORT.pages, ...bad] })) })
    expect(pages()).toEqual({ 'INDEX.md': EXPORT.index, 'notes/call-northwind.md': EXPORT.pages[1]!.markdown, 'people/priya.md': EXPORT.pages[0]!.markdown })
    expect(version()).toStartWith('7\n')
    await syncMemoryCopy([{ ...CHANNEL, dir: '../x' as never }], ENV, { root, fetch: api(() => Response.json(EXPORT)) })
    expect(readdirSync(root)).toEqual(['channel'])
  })

  test('a fetch past the time cap, an error status, an oversized export or no token leaves the old copy', async () => {
    await syncMemoryCopy([CHANNEL], ENV, { root, fetch: api(() => Response.json(EXPORT)) })
    const before = tree(join(root, 'channel'))
    const never = (async (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason)))) as unknown as typeof fetch
    const next = { ...CHANNEL, version: '8' }
    await syncMemoryCopy([next], ENV, { root, fetch: never, timeoutMs: 5 })
    await syncMemoryCopy([next], ENV, { root, fetch: api(() => Response.json({ error: 'nope', code: 'memory_not_found' }, { status: 404 })) })
    const many = Array.from({ length: 251 }, (_, i) => ({ type: 'note', slug: `n-${i}`, markdown: 'x' }))
    await syncMemoryCopy([next], ENV, { root, fetch: api(() => Response.json({ ...EXPORT, version: 8, pages: many })) })
    await syncMemoryCopy([next], ENV, { root, fetch: api(() => Response.json({ ...EXPORT, version: 8, index: 'x'.repeat(4 * 1024 * 1024) })) })
    await syncMemoryCopy([next], { ...ENV, KORTIX_TOKEN: '' }, { root, fetch: api(() => Response.json(EXPORT)) })
    expect(tree(join(root, 'channel'))).toEqual(before)
    expect(readdirSync(root)).toEqual(['channel'])
  })

  test('a sync waits for an earlier one of the same folder only up to its own cap', async () => {
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    const slow = api(async () => {
      await held
      return Response.json(EXPORT)
    })
    const first = syncMemoryCopy([CHANNEL], ENV, { root, fetch: slow })
    await syncMemoryCopy([{ ...CHANNEL, version: '8' }], ENV, { root, fetch: api(() => Response.json({ ...EXPORT, version: 8 })), timeoutMs: 5 })
    expect(calls).toHaveLength(1) // the second gave up waiting and fetched nothing
    release()
    await first
    expect(version()).toStartWith('7\n')
  })

  test('a link or a file where the folder belongs is replaced, never followed; leftovers of a crashed sync are removed', async () => {
    const elsewhere = mkdtempSync(join(tmpdir(), 'memory-copy-elsewhere-'))
    try {
      writeFileSync(join(elsewhere, 'keep.txt'), 'mine')
      symlinkSync(elsewhere, join(root, 'channel'))
      mkdirSync(join(root, 'channel.tmp-dead'))
      writeFileSync(join(root, 'company'), 'not a folder')
      await syncMemoryCopy([CHANNEL, { layer_id: 'layer-0', version: '3', dir: 'company' }], ENV, { root, fetch: api(() => Response.json(EXPORT)) })
      expect(lstatSync(join(root, 'channel')).isDirectory()).toBe(true)
      expect(lstatSync(join(root, 'company')).isDirectory()).toBe(true)
      expect(readdirSync(elsewhere)).toEqual(['keep.txt'])
      expect(statSync(elsewhere).mode & 0o777).not.toBe(0o555)
      expect(readdirSync(root).sort()).toEqual(['channel', 'company'])
    } finally {
      rmSync(elsewhere, { recursive: true, force: true })
    }
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
    const error = 'memory_layers must be [{ layer_id, version, dir: company | channel | personal }], each dir once'
    const layer = (dir: string) => ({ layer_id: 'l', version: 1, dir })
    for (const memory_layers of [
      {},
      [null],
      [{ layer_id: '', version: 1, dir: 'channel' }],
      [{ layer_id: 'l', version: 1.5, dir: 'channel' }],
      [{ layer_id: 'l', version: '1a', dir: 'channel' }],
      [layer('../etc')],
      [layer('channel'), layer('channel')],
      [layer('company'), layer('channel'), layer('personal'), layer('company')],
    ]) {
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

  test('a prompt that arrives while an earlier one of the session syncs starts after it', async () => {
    const order: string[] = []
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    const turns = {
      prompt: async (_id: string, input: RuntimePromptInput) => {
        order.push(`prompt ${input.messageId}`)
        return { status: 202, body: { message_id: input.messageId } }
      },
    } as unknown as HarnessTurnService
    const app = createRuntimeRouter({ sandboxToken: 'tok' } as Parameters<typeof createRuntimeRouter>[0], {} as Parameters<typeof createRuntimeRouter>[1], {
      turns,
      syncMemory: async () => {
        await held
        order.push('sync')
      },
    })
    const post = (body: Record<string, unknown>) =>
      app.request('/sessions/ses_1/prompt', { method: 'POST', headers: { Authorization: 'Bearer tok', 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const parts = [{ type: 'text', text: 'hi' }]
    const first = post({ message_id: 'msg_1', parts, memory_layers: [{ layer_id: 'layer-1', version: 7, dir: 'channel' }] })
    const second = post({ message_id: 'msg_2', parts, no_reply: true })
    await Bun.sleep(0)
    expect(order).toEqual([])
    release()
    expect((await first).status).toBe(202)
    expect((await second).status).toBe(202)
    expect(order).toEqual(['sync', 'prompt msg_1', 'prompt msg_2'])
  })
})
