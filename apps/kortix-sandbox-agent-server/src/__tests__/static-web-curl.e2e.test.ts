/**
 * Live curl e2e for the in-process static web server (src/static-web.ts).
 *
 * Boots the REAL server on an OS-assigned port, writes a real HTML page + asset
 * to disk under an allowed root, then drives every route with the actual `curl`
 * binary — exactly how the sandbox proxy reaches it in production. Asserts the
 * <base> tag injection (relative-asset rewriting) and the security boundary.
 */

import { execFile } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'

import { startStaticWebServer, type StaticWebServer } from '../static-web'

const execFileAsync = promisify(execFile)

type CurlResult = { status: number; contentType: string; body: string }

// Capture body + status + content-type in one shot. Markers keep parsing robust
// even when the body itself contains newlines.
async function curl(url: string, extraArgs: string[] = []): Promise<CurlResult> {
  const { stdout } = await execFileAsync(
    'curl',
    ['-sS', ...extraArgs, '-w', '\nKX_STATUS=%{http_code}\nKX_CT=%{content_type}', url],
    { encoding: 'utf8', timeout: 5_000 },
  )
  const statusIdx = stdout.lastIndexOf('\nKX_STATUS=')
  const body = stdout.slice(0, statusIdx)
  const tail = stdout.slice(statusIdx + 1) // "KX_STATUS=200\nKX_CT=text/html..."
  const status = Number(/KX_STATUS=(\d+)/.exec(tail)?.[1] ?? '0')
  const contentType = /KX_CT=(.*)$/s.exec(tail)?.[1]?.trim() ?? ''
  return { status, contentType, body }
}

describe('static web server live curl e2e', () => {
  let server: StaticWebServer
  let base: string
  let siteDir: string
  let indexPath: string
  let root: string

  beforeAll(() => {
    // Allowed roots are /workspace, /tmp, /home, /opt. /tmp works on the Linux
    // sandbox/CI and (via the /tmp→/private/tmp symlink) on macOS dev. We do
    // NOT use os.tmpdir() — on macOS that's /var/folders/... which is correctly
    // rejected by the server's allow-list.
    root = mkdtempSync('/tmp/kortix-static-e2e-')
    siteDir = join(root, 'site')
    mkdirSync(siteDir, { recursive: true })
    indexPath = join(siteDir, 'index.html')
    writeFileSync(
      indexPath,
      '<!doctype html><html><head><title>t</title></head>' +
        '<body><h1>hello</h1><link rel="stylesheet" href="style.css"></body></html>',
    )
    writeFileSync(join(siteDir, 'style.css'), 'body{color:red}')

    server = startStaticWebServer(0) // 0 → OS picks a free port
    base = `http://127.0.0.1:${server.port}`
  })

  afterAll(async () => {
    await server.stop()
    rmSync(root, { recursive: true, force: true })
  })

  it('binds and reports health', async () => {
    const res = await curl(`${base}/health`)
    expect(res.status).toBe(200)
    expect(JSON.parse(res.body)).toMatchObject({ status: 'ok', port: server.port })
  })

  it('serves /open and injects a public <base> from X-Forwarded-Prefix', async () => {
    const prefix = 'https://api.kortix.cloud/v1/p/sbx-123/3211'
    const res = await curl(`${base}/open?path=${encodeURIComponent(indexPath)}`, [
      '-H',
      `X-Forwarded-Prefix: ${prefix}`,
    ])
    expect(res.status).toBe(200)
    expect(res.contentType).toContain('text/html')
    // <base> must point at the PUBLIC proxy origin + /abs/<dir>/, not the
    // internal 127.0.0.1 address — otherwise relative assets 404 in the browser.
    expect(res.body).toContain(`<base href="${prefix}/abs${siteDir}/">`)
    // Hash-link fix script ships alongside the base tag.
    expect(res.body).toContain('scrollIntoView')
    expect(res.body).toContain('<h1>hello</h1>')
  })

  it('injects a root-anchored <base> for subdomain previews (bare http origin)', async () => {
    // Subdomain previews (p{port}-{sandbox}.host) serve at the host ROOT, so the
    // proxy sends X-Forwarded-Prefix as just the origin — no /v1/p/<id>/<port>
    // path segment. It must also honour http (local dev), not assume https, or
    // the browser loads relative assets over TLS against an http listener and
    // fails with ERR_SSL_PROTOCOL_ERROR. This is the exact prefix the fixed
    // subdomain proxy now produces.
    const prefix = 'http://p3211-sbx-123.localhost:8008'
    const res = await curl(`${base}/open?path=${encodeURIComponent(indexPath)}`, [
      '-H',
      `X-Forwarded-Prefix: ${prefix}`,
    ])
    expect(res.status).toBe(200)
    // Root-anchored: relative style.css resolves to {origin}/abs/<dir>/style.css,
    // which routes straight back to this server through the same subdomain.
    expect(res.body).toContain(`<base href="${prefix}/abs${siteDir}/">`)
  })

  it('serves assets via /abs with the right content-type', async () => {
    const res = await curl(`${base}/abs${siteDir}/style.css`)
    expect(res.status).toBe(200)
    expect(res.contentType).toContain('text/css')
    expect(res.body).toBe('body{color:red}')
  })

  it('auto-indexes a directory to index.html', async () => {
    const res = await curl(`${base}/abs${siteDir}/`)
    expect(res.status).toBe(200)
    expect(res.body).toContain('<h1>hello</h1>')
  })

  it('rejects paths outside the allow-list with 403', async () => {
    const res = await curl(`${base}/abs/etc/passwd`)
    expect(res.status).toBe(403)
  })

  it('returns 404 for a missing file under an allowed root', async () => {
    const res = await curl(`${base}/abs${siteDir}/missing.css`)
    expect(res.status).toBe(404)
  })
})
