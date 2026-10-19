import { describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { coordinatesGoal, runOnIdleHook } from './on-idle-hook'

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

describe('coordinatesGoal', () => {
  test('finds a goal folder naming the session as coordinator, not as worker or verifier', () => {
    const root = mkdtempSync(join(tmpdir(), 'drives-'))
    const folder = join(root, 'me', 'Goals', 'rho')
    require('node:fs').mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, 'goal.json'), JSON.stringify({ sessions: [{ id: 'coord', role: 'coordinator' }, { id: 'ver', role: 'verifier' }] }))
    expect(coordinatesGoal('coord', root)).toBe(true)
    expect(coordinatesGoal('ver', root)).toBe(false)
    expect(coordinatesGoal('other', root)).toBe(false)
    expect(coordinatesGoal(undefined, root)).toBe(false)
    expect(coordinatesGoal('coord', join(root, 'missing'))).toBe(false)
  })

  test('without a hook, a coordinating session still runs (the goal check)', () => {
    const root = mkdtempSync(join(tmpdir(), 'drives-'))
    const folder = join(root, 'me', 'Goals', 'rho')
    require('node:fs').mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, 'goal.json'), JSON.stringify({ sessions: [{ id: 'coord', role: 'coordinator' }] }))
    const logPath = join(root, 'log')
    expect(runOnIdleHook({ status: 'idle', messageId: 'm' }, { path: join(root, 'no-hook'), logPath, drivesRoot: root, sessionId: 'coord' })).toBe(true)
    expect(runOnIdleHook({ status: 'idle', messageId: 'm' }, { path: join(root, 'no-hook'), logPath, drivesRoot: root, sessionId: 'other' })).toBe(false)
  })
})
