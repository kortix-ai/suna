import { describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runOnIdleHook } from './on-idle-hook'

describe('runOnIdleHook', () => {
  test('runs an executable hook with the turn status; a missing or non-executable one is skipped', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'on-idle-'))
    const hook = join(dir, 'on-idle')
    const out = join(dir, 'out')
    const logPath = join(dir, 'log')
    expect(runOnIdleHook({ status: 'idle', messageId: 'm1' }, { path: hook, logPath })).toBe(false)
    writeFileSync(hook, `#!/bin/sh\necho "$KORTIX_TURN_STATUS $KORTIX_TURN_MESSAGE_ID" > ${JSON.stringify(out)}\n`)
    expect(runOnIdleHook({ status: 'idle', messageId: 'm1' }, { path: hook, logPath })).toBe(false)
    chmodSync(hook, 0o755)
    expect(runOnIdleHook({ status: 'error', messageId: 'm2' }, { path: hook, logPath })).toBe(true)
    for (let i = 0; i < 50 && !existsSync(out); i++) await Bun.sleep(20)
    expect(readFileSync(out, 'utf8').trim()).toBe('error m2')
  })
})
