import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'

describe('local public base sync', () => {
  test('share proxy ensures local ngrok base before create/list operations', () => {
    const source = readFileSync(join(import.meta.dir, '../sandbox-proxy/routes/share.ts'), 'utf8')

    expect(source).toContain("import { ensureLocalSandboxPublicBase } from '../../platform/services/local-public-base'")
    expect(source).toContain('localPublicBaseUrl = await ensureLocalSandboxPublicBase(target.resolved.baseUrl, target.resolved.serviceKey)')
    expect(source).toContain('await ensureLocalSandboxPublicBase(target.resolved.baseUrl, target.resolved.serviceKey)')
  })

  test('startup self-heal syncs PUBLIC_BASE_URL for local sandbox', () => {
    const source = readFileSync(join(import.meta.dir, '../index.ts'), 'utf8')

    expect(source).toContain("import { ensureLocalSandboxPublicBase } from './platform/services/local-public-base';")
    expect(source).toContain("console.log('[startup] Local sandbox PUBLIC_BASE_URL synced');")
  })
})
