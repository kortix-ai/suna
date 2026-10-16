import { afterAll, describe, expect, test } from 'bun:test'
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'
import { promptImages } from '@/harness/pi/images'

/** A solid-colour RGB PNG, red on the left half and blue on the right. */
function swatch(width: number, height: number): Buffer {
  const row = Buffer.alloc(1 + width * 3)
  for (let x = 0; x < width; x++) row.set(x < width / 2 ? [220, 30, 30] : [30, 60, 220], 1 + x * 3)
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
    chunk('IDAT', deflateSync(Buffer.concat(Array.from({ length: height }, () => row)))),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const dirs: string[] = []
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-images-'))
  dirs.push(dir)
  return dir
}
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

const PNG = swatch(96, 96)
/** pi's resize as the runtime passes it, stubbed: the bytes back, as base64. */
const passThrough = async (bytes: Uint8Array, mime: string) => ({ data: Buffer.from(bytes).toString('base64'), mimeType: mime })
const tag = (path: string, mime = 'image/png') => `<file path="${path}" mime="${mime}" filename="swatch.png">\nThis file has been uploaded and is available at the path above.\n</file>`

describe('promptImages', () => {
  const workspace = tempDir()
  const inbox = join(workspace, 'uploads', '.kortix-inbox', 'cmd_1')
  mkdirSync(inbox, { recursive: true })
  writeFileSync(join(inbox, '1-swatch.png'), PNG)
  writeFileSync(join(inbox, '2-notes.pdf'), '%PDF-1.4')
  writeFileSync(join(workspace, 'outside.png'), PNG)

  test('an inbox image a `<file>` tag names becomes image content', async () => {
    const images = await promptImages({ text: `look ${tag(join(inbox, '1-swatch.png'))}`, files: [] }, workspace, passThrough)
    expect(images).toEqual([{ type: 'image', data: PNG.toString('base64'), mimeType: 'image/png' }])
  })

  test('a non-image file, a file outside the inbox and a missing file stay tags only', async () => {
    const text = [
      tag(join(inbox, '2-notes.pdf'), 'application/pdf'),
      tag(join(workspace, 'outside.png')),
      tag(join(inbox, '..', '..', '..', 'outside.png')),
      tag(join(inbox, 'missing.png')),
    ].join('\n')
    expect(await promptImages({ text, files: [] }, workspace, passThrough)).toEqual([])
  })

  test('a data-URL image part is attached; an image pi cannot resize is left out', async () => {
    const files = [{ mime: 'image/png', url: `data:image/png;base64,${PNG.toString('base64')}` }]
    expect(await promptImages({ text: '', files }, workspace, passThrough)).toHaveLength(1)
    expect(await promptImages({ text: tag(join(inbox, '1-swatch.png')), files }, workspace, async () => null)).toEqual([])
  })
})

describe('images in the compiled daemon', () => {
  test('the embedded photon wasm is the version pi loads', async () => {
    const own = (await import('../../package.json')).dependencies['@silvia-odwyer/photon-node']
    const pi = JSON.parse(await Bun.file(join(import.meta.dir, '../../node_modules/@earendil-works/pi-coding-agent/package.json')).text())
    expect(own).toBe(pi.dependencies['@silvia-odwyer/photon-node'])
  })

  // The box runs a `bun build --compile` binary. photon-node reads its wasm from the BUILD
  // machine's path at load: the check builds against a copy of the package, deletes the copy,
  // then runs the binary, as a box runs it.
  test('pi reads an image and a prompt tag attaches it', async () => {
    const dir = tempDir()
    const photonCopy = join(dir, 'photon-node')
    cpSync(realpathSync(join(import.meta.dir, '../../node_modules/@silvia-odwyer/photon-node')), photonCopy, { recursive: true })
    const outfile = join(dir, 'probe')
    // Bun leaves a 70 MB `.<hash>.bun-build` runtime copy in the working directory: build from the temp dir.
    const cwd = process.cwd()
    process.chdir(dir)
    const built = await Bun.build({
      entrypoints: [join(import.meta.dir, 'fixtures/pi-image-probe.ts')],
      compile: { outfile },
      tsconfig: join(import.meta.dir, '../../tsconfig.json'),
      plugins: [{
        name: 'photon-copy',
        setup(build) {
          build.onResolve({ filter: /^@silvia-odwyer\/photon-node(\/.*)?$/ }, (args) => ({
            path: join(photonCopy, args.path.slice('@silvia-odwyer/photon-node'.length) || 'photon_rs.js'),
          }))
        },
      }],
    }).finally(() => process.chdir(cwd))
    expect(built.success, built.logs.join('\n')).toBe(true)
    rmSync(photonCopy, { recursive: true })

    const workspace = join(dir, 'workspace')
    const file = join(workspace, 'uploads', '.kortix-inbox', 'cmd_1', '1-swatch.png')
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, PNG)
    const run = Bun.spawnSync([outfile, file, workspace], { cwd: dir, stderr: 'pipe' })
    expect(run.exitCode, run.stderr.toString()).toBe(0)
    const out = JSON.parse(run.stdout.toString()) as { read: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; prompt: unknown[] }
    expect(out.read).toEqual([
      { type: 'text', text: 'Read image file [image/png]' },
      { type: 'image', data: PNG.toString('base64'), mimeType: 'image/png' },
    ])
    expect(out.prompt).toEqual([{ type: 'image', data: PNG.toString('base64'), mimeType: 'image/png' }])
  }, 120_000)
})
