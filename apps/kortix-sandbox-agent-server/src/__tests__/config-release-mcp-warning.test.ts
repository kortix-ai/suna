import { test, expect } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prepareConfigDir } from '@/harness/open-code/config-release'
import { logger } from '@/lib/log/logger'

test('warns about legacy harness MCP declarations without logging their contents', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-guard-'))
  const warn = logger.warn
  const messages: string[] = []
  logger.warn = ((message: string) => { messages.push(message) }) as typeof logger.warn
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'opencode.jsonc'), '{ "mcp": { "private-server": { "token": "secret" } } }')
    await prepareConfigDir(dir)
    expect(messages.some(message => message.includes('Kortix connectors'))).toBe(true)
    expect(messages.join(' ')).not.toContain('secret')
  } finally {
    logger.warn = warn
    rmSync(dir, { recursive: true, force: true })
  }
})
