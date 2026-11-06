import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'
import { createReadToolDefinition } from '@earendil-works/pi-coding-agent'
import { IMAGE_RESIZE, createPiModels, compactionSettings } from '@/harness/pi/model'
import '@/harness/pi/images'

let picker: () => Response = () => Response.json({ models: { 'myendpoint/big': { name: 'Big', limit: { context: 1_048_576 } } } })
let pickerCalls = 0
const server = Bun.serve({
  port: 0,
  fetch: (req) => {
    if (new URL(req.url).searchParams.get('scope') !== 'picker') return new Response('no', { status: 404 })
    pickerCalls += 1
    return picker()
  },
})
afterAll(() => server.stop(true))

const env = (): NodeJS.ProcessEnv => ({
  KORTIX_LLM_BASE_URL: `http://127.0.0.1:${server.port}`,
  KORTIX_TOKEN: 'tok',
  KORTIX_LLM_PROXY_DISABLE: '1',
})

test('pi sizes a model from the live picker catalog', async () => {
  const models = await createPiModels({ env: env(), defaultModelRef: 'kortix/myendpoint/big' })
  expect(models.live).toBe(true)
  const big = models.select('myendpoint/big').model
  expect(big.contextWindow).toBe(1_048_576)
  // No output limit reported: pi clamps max_tokens to the room left in the window.
  expect(big.maxTokens).toBe(1_048_576)
})

test('a picker that fails once is asked again', async () => {
  pickerCalls = 0
  let first = true
  picker = () => {
    if (first) {
      first = false
      return new Response('blip', { status: 503 })
    }
    return Response.json({ models: { 'myendpoint/big': { name: 'Big', limit: { context: 1_048_576 } } } })
  }
  const models = await createPiModels({ env: env(), defaultModelRef: null })
  expect(pickerCalls).toBe(2)
  expect(models.live).toBe(true)
  // No session model: the fallback is a model the project can run.
  expect(models.select(null).modelID).toBe('myendpoint/big')
})

test('a dead picker leaves every model on default limits', async () => {
  picker = () => new Response('down', { status: 503 })
  const models = await createPiModels({ env: env(), defaultModelRef: 'kortix/myendpoint/big' })
  expect(models.live).toBe(false)
  expect(models.select('myendpoint/big').model).toMatchObject({ contextWindow: 128_000, maxTokens: 32_768, input: ['text'] })
  // No session model and no catalog: nothing to run, and the error says why.
  await expect(createPiModels({ env: env(), defaultModelRef: null })).rejects.toThrow('no live model catalog')
})

test('the compaction reserve is the model output limit, so the answer always has room', () => {
  const overrides = compactionSettings({
    'agent/big': { limit: { context: 128_000, output: 32_768 } },
    'agent/long-answer': { limit: { context: 200_000, output: 64_000 } },
    // A model that claims most of its window as output still compacts at half the window.
    'agent/greedy': { limit: { context: 1_048_576, output: 943_718 } },
    // pi's own default already covers a small output limit: no override.
    'agent/small': { limit: { context: 64_000, output: 8_000 } },
    // No output limit reported: pi caps the request at the window, so the reserve is capped too.
    'agent/window-only': { limit: { context: 1_048_576 } },
  }).modelOverrides
  expect(overrides).toEqual({
    'kortix/agent/big': { reserveTokens: 32_768 },
    'kortix/agent/long-answer': { reserveTokens: 64_000 },
    'kortix/agent/greedy': { reserveTokens: 524_288 },
    'kortix/agent/window-only': { reserveTokens: 524_288 },
  })
})

test('a configured reserve raises the threshold earlier, never later than the output budget', () => {
  const models = { 'agent/big': { limit: { context: 128_000, output: 32_768 } }, 'agent/small': { limit: { context: 64_000, output: 8_000 } } }
  // A project that wants an earlier cut gets it on both models, capped at half the window.
  expect(compactionSettings(models, 40_000).modelOverrides).toEqual({
    'kortix/agent/big': { reserveTokens: 40_000 },
    'kortix/agent/small': { reserveTokens: 32_000 },
  })
  // A configured reserve below the output limit never shrinks the answer's room.
  expect(compactionSettings(models, 4_096).modelOverrides['kortix/agent/big']).toEqual({ reserveTokens: 32_768 })
})

/** A 1600x1200 photo-like RGB PNG: smooth fields plus fine texture, which PNG cannot compress and JPEG can. */
function aerialPng(): Buffer {
  const width = 1600
  const height = 1200
  let seed = 7
  const noise = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % 33) - 16
  const rows: Buffer[] = []
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 3)
    for (let x = 0; x < width; x++) {
      const field = ((x >> 7) + (y >> 7)) % 3
      row.set([80 + field * 40 + noise(), 110 + noise(), 60 + field * 20 + noise()], 1 + x * 3)
    }
    rows.push(row)
  }
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(Bun.hash.crc32(body))
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    return Buffer.concat([length, body, crc])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header.set([8, 2, 0, 0, 0], 8)
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// 2026-11-02: a session read 1600x1200 aerial PNGs (2.7 MB each) four at a time. pi kept every
// one as PNG (under its 4.5 MB default), twelve made a 43 MB request, and Bedrock refused it.
test('an image model reads a large photo PNG as a JPEG of the same size under 1.5 MB', async () => {
  picker = () => Response.json({ models: { 'myendpoint/vision': { name: 'Vision', attachment: true, limit: { context: 200_000 } } } })
  const models = await createPiModels({ env: env(), defaultModelRef: 'kortix/myendpoint/vision' })
  const model = models.select('myendpoint/vision').model
  expect(model.inputLimits).toEqual({ images: { resize: { ...IMAGE_RESIZE } } })

  const dir = mkdtempSync(join(tmpdir(), 'pi-read-image-'))
  try {
    const png = aerialPng()
    writeFileSync(join(dir, 'sheet.png'), png)
    // Over pi's own 1.5 MB cap, under its 4.5 MB default: the default sends this PNG unchanged.
    expect(Math.ceil(png.length / 3) * 4).toBeGreaterThan(IMAGE_RESIZE.maxBytes)
    const read = createReadToolDefinition(dir)
    const result = await read.execute('call-1', { path: 'sheet.png' }, undefined, undefined, { cwd: dir, model } as never)
    const image = result.content.find((part) => part.type === 'image') as { data: string; mimeType: string }
    expect(image.mimeType).toBe('image/jpeg')
    expect(image.data.length).toBeLessThan(IMAGE_RESIZE.maxBytes)
    const jpeg = Buffer.from(image.data, 'base64')
    // SOF0 carries the height then the width: the same 1600x1200 pixels, so the same image tokens.
    const sof = jpeg.indexOf(Buffer.from([0xff, 0xc0]))
    expect([jpeg.readUInt16BE(sof + 7), jpeg.readUInt16BE(sof + 5)]).toEqual([1600, 1200])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a text-only model carries no image limits', async () => {
  picker = () => Response.json({ models: { 'myendpoint/text': { name: 'Text', limit: { context: 200_000 } } } })
  const models = await createPiModels({ env: env(), defaultModelRef: 'kortix/myendpoint/text' })
  expect(models.select('myendpoint/text').model.inputLimits).toBeUndefined()
})

