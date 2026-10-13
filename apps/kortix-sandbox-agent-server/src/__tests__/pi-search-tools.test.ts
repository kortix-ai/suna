import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createGlobTool, createGrepTool } from '@/harness/pi/tools'

/** glob/grep run rg on the box; a huge result must not be held in memory whole. */
let dir: string
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'pi-search-'))
  // ~3,000 paths of ~110 bytes: ~330 KB of glob output, past the 100 KB capture cap.
  for (let i = 0; i < 3000; i += 1) writeFileSync(join(dir, `${'x'.repeat(100)}-${i}.txt`), 'needle\n')
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const text = (result: { content: Array<{ type: string; text?: string }> }) => result.content[0]!.text ?? ''

test('glob stops rg at the capture cap and says more results exist', async () => {
  const out = text(await createGlobTool(dir).execute('t1', { pattern: '*.txt' }, undefined))
  expect(out).toContain('more results exist')
  expect(Buffer.byteLength(out)).toBeLessThan(60 * 1024)
})

test('grep under the cap returns every match without the cap note', async () => {
  const out = text(await createGrepTool(dir).execute('t2', { pattern: 'needle', include: '*-1?.txt' }, undefined))
  expect(out.split('\n').filter((line) => line.includes('needle'))).toHaveLength(10)
  expect(out).not.toContain('more results exist')
})

test('a caller abort still rejects', async () => {
  const controller = new AbortController()
  controller.abort()
  await expect(createGlobTool(dir).execute('t3', { pattern: '*.txt' }, controller.signal)).rejects.toThrow('aborted')
})
