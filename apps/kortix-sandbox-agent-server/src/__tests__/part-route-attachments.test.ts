/**
 * /kortix/part serves tool-result attachments (nested in `state.attachments`)
 * and offloaded ones from their sidecar file.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { OFFLOAD_PLACEHOLDER_URL } from '../attachment-offload'
import type { Opencode } from '../opencode'
import { createPartRouter, findAttachment } from '../routes/part'

let root: string
let server: ReturnType<typeof Bun.serve> | null = null
const ORIGINAL_FETCH = globalThis.fetch

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kortix-part-'))
})

afterEach(() => {
  server?.stop(true)
  server = null
  globalThis.fetch = ORIGINAL_FETCH
  rmSync(root, { recursive: true, force: true })
})

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64')

function fakeOpencode(port: number): Opencode {
  return { getInternalUrl: () => `http://127.0.0.1:${port}` } as unknown as Opencode
}

describe('findAttachment', () => {
  test('finds a top-level file part and a nested tool attachment by id', () => {
    const parts = [
      { type: 'file', id: 'f1', url: 'data:x' },
      { type: 'tool', state: { attachments: [{ type: 'file', id: 'a1', url: 'data:y' }] } },
    ]
    expect(findAttachment(parts as any, 'f1')?.url).toBe('data:x')
    expect(findAttachment(parts as any, 'a1')?.url).toBe('data:y')
    expect(findAttachment(parts as any, 'zz')).toBeNull()
  })
})

describe('GET /kortix/part/:s/:m/:p', () => {
  test('serves a tool screenshot from its nested attachment, and an offloaded one from the sidecar', async () => {
    const sidecar = join(root, 'prt_off')
    writeFileSync(sidecar, PNG)
    const inlineB64 = Buffer.from('inline-bytes').toString('base64')
    const message = {
      info: { id: 'msg_1' },
      parts: [
        {
          type: 'tool',
          id: 'prt_tool',
          state: {
            attachments: [
              { type: 'file', id: 'prt_inline', mime: 'image/png', url: `data:image/png;base64,${inlineB64}` },
              {
                type: 'file',
                id: 'prt_off',
                mime: 'image/png',
                url: OFFLOAD_PLACEHOLDER_URL,
                kortix: { offloaded: true, sidecar, bytes: PNG.byteLength, mime: 'image/png', at: 't' },
              },
              {
                type: 'file',
                id: 'prt_gone',
                mime: 'image/png',
                url: OFFLOAD_PLACEHOLDER_URL,
                kortix: { offloaded: true, sidecar: join(root, 'missing'), bytes: 1, mime: 'image/png', at: 't' },
              },
            ],
          },
        },
      ],
    }
    server = Bun.serve({ port: 0, fetch: () => Response.json(message) })
    const app = createPartRouter(fakeOpencode(server.port as number))

    const inline = await app.request('http://d/ses/msg_1/prt_inline')
    expect(inline.status).toBe(200)
    expect(Buffer.from(await inline.arrayBuffer()).toString()).toBe('inline-bytes')

    const off = await app.request('http://d/ses/msg_1/prt_off')
    expect(off.status).toBe(200)
    expect(off.headers.get('content-type')).toBe('image/png')
    expect(Buffer.from(await off.arrayBuffer()).equals(PNG)).toBe(true)

    const gone = await app.request('http://d/ses/msg_1/prt_gone')
    expect(gone.status).toBe(410)

    const nope = await app.request('http://d/ses/msg_1/prt_nope')
    expect(nope.status).toBe(404)
  })
})

describe('offloaded attachment read through OpenCode (marker stripped by its schema)', () => {
  test('the placeholder URL + attachment id resolve the sidecar; a placeholder with no sidecar falls back to its own bytes', async () => {
    const sidecarDir = join(root, 'attachments')
    const { mkdirSync } = await import('node:fs')
    mkdirSync(sidecarDir, { recursive: true })
    writeFileSync(join(sidecarDir, 'prt_byid'), PNG)
    const message = {
      info: { id: 'msg_1' },
      parts: [
        {
          type: 'tool',
          id: 'prt_tool',
          state: {
            attachments: [
              // What OpenCode returns for an offloaded row: placeholder URL, NO kortix field.
              { type: 'file', id: 'prt_byid', mime: 'image/png', url: OFFLOAD_PLACEHOLDER_URL },
              { type: 'file', id: 'prt_nosidecar', mime: 'image/png', url: OFFLOAD_PLACEHOLDER_URL },
            ],
          },
        },
      ],
    }
    server = Bun.serve({ port: 0, fetch: () => Response.json(message) })
    const app = createPartRouter(fakeOpencode(server.port as number), { sidecarDir })

    const byId = await app.request('http://d/ses/msg_1/prt_byid')
    expect(byId.status).toBe(200)
    expect(Buffer.from(await byId.arrayBuffer()).equals(PNG)).toBe(true)

    const fallback = await app.request('http://d/ses/msg_1/prt_nosidecar')
    expect(fallback.status).toBe(200)
    expect(Buffer.from(await fallback.arrayBuffer()).byteLength).toBe(68) // the 1×1 placeholder itself
  })
})
