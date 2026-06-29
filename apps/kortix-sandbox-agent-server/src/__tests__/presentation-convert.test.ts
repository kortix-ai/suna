import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import type { Config } from '../config'
import { createPresentationRouter, parseScriptResult, type ConvertRunner } from '../routes/presentation'

function baseConfig(workspace: string): Config {
  return {
    servicePort: 8000,
    opencodeInternalPort: 4096,
    staticPort: 3211,
    workspace,
    projectTarget: workspace,
    defaultBranch: 'main',
    branchFetchAttempts: 60,
    branchFetchDelaySec: 0.25,
    defaultOpencodeConfigDir: '/ephemeral/opencode',
    autoClone: false,
    projectId: 'project-1',
    apiUrl: 'http://api.test/v1',
    repoUrl: undefined,
    branchName: undefined,
    sessionFresh: false,
    baseSha: undefined,
    sandboxToken: 'test-token',
    gitUserName: 'Kortix Agent',
    gitUserEmail: 'agent@kortix.ai',
    cloneFilter: '',
  }
}

/** Create a deck on disk: a presentations/<name> dir with metadata.json + a slide. */
async function makeDeck(workspace: string, name: string): Promise<string> {
  const presDir = path.join(workspace, 'presentations', name)
  await fs.mkdir(presDir, { recursive: true })
  await fs.writeFile(
    path.join(presDir, 'metadata.json'),
    JSON.stringify({ presentation_name: name, title: name, slides: { '1': { title: 'One', filename: 'slide_01.html' } } }),
  )
  await fs.writeFile(path.join(presDir, 'slide_01.html'), '<html><body>1</body></html>')
  return presDir
}

const tick = () => new Promise<void>((r) => setTimeout(r, 5))

/** A runner that returns null scripts dir is never needed; a present one suffices. */
const scriptsPresent = async () => '/fake/scripts'

function post(app: ReturnType<typeof createPresentationRouter>, format: string, presentation_path: unknown) {
  return app.request(`/convert-to-${format}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ presentation_path }),
  })
}

describe('parseScriptResult', () => {
  it('parses a success line', () => {
    expect(parseScriptResult('{"success": true, "output_path": "/x.pdf"}')).toEqual({ success: true })
  })
  it('parses a failure line with the error', () => {
    expect(parseScriptResult('{"success": false, "error": "no slides"}')).toEqual({
      success: false,
      error: 'no slides',
    })
  })
  it('finds the JSON result among noisy stderr-like lines', () => {
    const out = 'warning: something\n{"success": true, "output_path": "/x.pptx"}\n'
    expect(parseScriptResult(out)).toEqual({ success: true })
  })
  it('returns null when there is no result line', () => {
    expect(parseScriptResult('just some logs\nno json here')).toBeNull()
  })
})

describe('presentation convert router', () => {
  let workspace: string

  beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'kortix-pres-test-'))
  })
  afterEach(async () => {
    if (workspace) await fs.rm(workspace, { recursive: true, force: true })
  })

  it('400 on invalid JSON body', async () => {
    const app = createPresentationRouter(baseConfig(workspace), { resolveScriptsDir: scriptsPresent })
    const res = await app.request('/convert-to-pdf', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json',
    })
    expect(res.status).toBe(400)
  })

  it('400 when presentation_path is missing', async () => {
    const app = createPresentationRouter(baseConfig(workspace), { resolveScriptsDir: scriptsPresent })
    const res = await app.request('/convert-to-pdf', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
  })

  it('403 for a path outside the allowed roots', async () => {
    const app = createPresentationRouter(baseConfig(workspace), { resolveScriptsDir: scriptsPresent })
    const res = await post(app, 'pdf', '/etc/secret-deck')
    expect(res.status).toBe(403)
  })

  it('404 for a presentation directory that does not exist', async () => {
    const app = createPresentationRouter(baseConfig(workspace), { resolveScriptsDir: scriptsPresent })
    const res = await post(app, 'pdf', `${workspace}/presentations/nope`)
    expect(res.status).toBe(404)
  })

  it('404 when the directory has no metadata.json', async () => {
    const dir = path.join(workspace, 'presentations', 'empty')
    await fs.mkdir(dir, { recursive: true })
    const app = createPresentationRouter(baseConfig(workspace), { resolveScriptsDir: scriptsPresent })
    const res = await post(app, 'pdf', dir)
    expect(res.status).toBe(404)
  })

  it('501 when the conversion tooling is unavailable', async () => {
    await makeDeck(workspace, 'deck')
    const app = createPresentationRouter(baseConfig(workspace), { resolveScriptsDir: async () => null })
    const res = await post(app, 'pdf', `${workspace}/presentations/deck`)
    expect(res.status).toBe(501)
  })

  it('streams an existing, up-to-date render immediately (200 + headers + bytes)', async () => {
    const presDir = await makeDeck(workspace, 'deck')
    // Render produced AFTER the slides → fresh.
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]) // %PDF-
    await fs.writeFile(path.join(presDir, 'deck.pdf'), bytes)

    const app = createPresentationRouter(baseConfig(workspace), { resolveScriptsDir: scriptsPresent })
    const res = await post(app, 'pdf', presDir)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/pdf')
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="deck.pdf"')
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([...bytes])
  })

  it('regenerates a stale render rather than serving it', async () => {
    const presDir = await makeDeck(workspace, 'deck')
    // Render older than the slide → stale.
    await fs.writeFile(path.join(presDir, 'deck.pdf'), new Uint8Array([1]))
    const old = new Date(Date.now() - 60_000)
    await fs.utimes(path.join(presDir, 'deck.pdf'), old, old)

    let calls = 0
    const runConvert: ConvertRunner = async (_f, _d, outPath) => {
      calls++
      await fs.writeFile(outPath, new Uint8Array([0x25, 0x50, 0x44, 0x46]))
      return { success: true }
    }
    const app = createPresentationRouter(baseConfig(workspace), {
      runConvert,
      resolveScriptsDir: scriptsPresent,
    })
    const first = await post(app, 'pdf', presDir)
    expect(first.status).toBe(202) // stale → kicks off a regeneration
    expect(calls).toBe(1)
  })

  it('generates in the background: 202 while running (single-flight), then 200 with the file', async () => {
    const presDir = await makeDeck(workspace, 'deck')
    let calls = 0
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    const runConvert: ConvertRunner = async (format, _d, outPath) => {
      calls++
      await gate
      await fs.writeFile(
        outPath,
        format === 'pptx' ? new Uint8Array([0x50, 0x4b, 0x03, 0x04]) : new Uint8Array([0x25, 0x50, 0x44, 0x46]),
      )
      return { success: true }
    }
    const app = createPresentationRouter(baseConfig(workspace), {
      runConvert,
      resolveScriptsDir: scriptsPresent,
    })

    const r1 = await post(app, 'pptx', presDir)
    expect(r1.status).toBe(202)
    expect(await r1.json()).toEqual({ status: 'generating' })

    // A second poll while still running must NOT start a second conversion.
    const r2 = await post(app, 'pptx', presDir)
    expect(r2.status).toBe(202)
    expect(calls).toBe(1)

    release()
    await tick()

    const r3 = await post(app, 'pptx', presDir)
    expect(r3.status).toBe(200)
    expect(res_contentType(r3)).toContain('presentationml.presentation')
    expect((await r3.arrayBuffer()).byteLength).toBe(4)
  })

  it('surfaces a conversion failure once (500), then allows a retry', async () => {
    const presDir = await makeDeck(workspace, 'deck')
    let calls = 0
    const runConvert: ConvertRunner = async () => {
      calls++
      return { success: false, error: 'no valid slides found' }
    }
    const app = createPresentationRouter(baseConfig(workspace), {
      runConvert,
      resolveScriptsDir: scriptsPresent,
    })

    const r1 = await post(app, 'pdf', presDir)
    expect(r1.status).toBe(202)
    await tick()

    const r2 = await post(app, 'pdf', presDir)
    expect(r2.status).toBe(500)
    expect(((await r2.json()) as { error?: string }).error).toContain('no valid slides')
    expect(calls).toBe(1)

    // Error was surfaced + cleared → a later request starts a fresh conversion.
    const r3 = await post(app, 'pdf', presDir)
    expect(r3.status).toBe(202)
    await tick()
    expect(calls).toBe(2)
  })

  it('resolves a deck via the sanitized name when the raw path misses', async () => {
    // The viewer sometimes posts the raw presentation name; the on-disk dir is
    // the sanitized form (lowercased, non-[a-z0-9_-] stripped). "MyDeck" → "mydeck".
    const presDir = await makeDeck(workspace, 'mydeck')
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46])
    await fs.writeFile(path.join(presDir, 'mydeck.pdf'), bytes)

    const app = createPresentationRouter(baseConfig(workspace), { resolveScriptsDir: scriptsPresent })
    const res = await post(app, 'pdf', `${workspace}/presentations/MyDeck`)
    expect(res.status).toBe(200)
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([...bytes])
  })
})

function res_contentType(res: Response): string {
  return res.headers.get('content-type') || ''
}
