import { describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GOAL_CHECK_COMMAND, runOnIdleHook } from './on-idle-hook'

async function waitFor(path: string, contains = ''): Promise<string> {
  for (let i = 0; i < 100; i++) {
    if (existsSync(path)) {
      const text = readFileSync(path, 'utf8')
      if (text.includes(contains)) return text
    }
    await Bun.sleep(20)
  }
  return existsSync(path) ? readFileSync(path, 'utf8') : ''
}

/** A stand-in for `kortix goals check`: records the turn it was run for, then exits with `code`. */
function fakeCheck(dir: string, code = 0): { command: string; out: string } {
  const out = join(dir, 'check-out')
  const script = join(dir, 'check.sh')
  writeFileSync(script, `#!/bin/sh\necho "check $KORTIX_TURN_MESSAGE_ID" >> ${JSON.stringify(out)}\nexit ${code}\n`)
  chmodSync(script, 0o755)
  return { command: JSON.stringify(script), out }
}

describe('runOnIdleHook', () => {
  test('runs an executable hook with the turn status; a missing or non-executable one is skipped', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'on-idle-'))
    const hook = join(dir, 'on-idle')
    const out = join(dir, 'out')
    const logPath = join(dir, 'log')
    const env = { KORTIX_FEATURE_FLAGS: 'volumes' }
    expect(runOnIdleHook({ status: 'idle', messageId: 'm1' }, { path: hook, logPath, env })).toEqual([])
    writeFileSync(hook, `#!/bin/sh\necho "$KORTIX_TURN_STATUS $KORTIX_TURN_MESSAGE_ID" > ${JSON.stringify(out)}\n`)
    expect(runOnIdleHook({ status: 'idle', messageId: 'm1' }, { path: hook, logPath, env })).toEqual([])
    chmodSync(hook, 0o755)
    expect(runOnIdleHook({ status: 'error', messageId: 'm2' }, { path: hook, logPath, env })).toEqual([JSON.stringify(hook)])
    expect((await waitFor(out)).trim()).toBe('error m2')
  })

  test('goals on: the goal check runs next to a custom hook, with the turn id', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'on-idle-'))
    const hook = join(dir, 'on-idle')
    const hookOut = join(dir, 'hook-out')
    writeFileSync(hook, `#!/bin/sh\necho hook > ${JSON.stringify(hookOut)}\n`)
    chmodSync(hook, 0o755)
    const check = fakeCheck(dir)
    const env = { KORTIX_FEATURE_FLAGS: 'volumes,goals,reminders' }
    const started = runOnIdleHook({ status: 'idle', messageId: 'turn-7' }, { path: hook, logPath: join(dir, 'log'), env, goalCheckCommand: check.command })
    expect(started).toEqual([JSON.stringify(hook), check.command])
    expect((await waitFor(hookOut)).trim()).toBe('hook')
    expect((await waitFor(check.out)).trim()).toBe('check turn-7')
  })

  test('the default goal check is the CLI, and goals off runs no goal check', () => {
    const dir = mkdtempSync(join(tmpdir(), 'on-idle-'))
    const none = join(dir, 'no-hook')
    expect(GOAL_CHECK_COMMAND).toBe('kortix goals check --enforce --quiet')
    expect(runOnIdleHook({ status: 'idle', messageId: 'm' }, { path: none, logPath: join(dir, 'log'), env: { KORTIX_FEATURE_FLAGS: 'volumes,reminders' } })).toEqual([])
  })

  test('the owner is not read from GOAL.md: YAML key order changes nothing, the CLI decides', async () => {
    // role before id is valid YAML that the old regex owner detection missed.
    const root = mkdtempSync(join(tmpdir(), 'drives-'))
    const folder = join(root, 'me', 'Goals', 'eu-billing')
    mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, 'GOAL.md'), ['---', 'goal: EU billing', 'sessions:', '  - role: owner', '    id: owner', '---', ''].join('\n'))
    const check = fakeCheck(root)
    const env = { KORTIX_FEATURE_FLAGS: 'goals', KORTIX_DRIVES_ROOT: root, KORTIX_SESSION_ID: 'owner' }
    expect(runOnIdleHook({ status: 'idle', messageId: 'm' }, { path: join(root, 'no-hook'), logPath: join(root, 'log'), env, goalCheckCommand: check.command })).toEqual([check.command])
    expect((await waitFor(check.out)).trim()).toBe('check m')
  })

  test('a failed goal check is logged with its exit code', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'on-idle-'))
    const check = fakeCheck(dir, 3)
    const logPath = join(dir, 'log')
    runOnIdleHook({ status: 'idle', messageId: 'turn-9' }, { path: join(dir, 'no-hook'), logPath, env: { KORTIX_FEATURE_FLAGS: 'goals' }, goalCheckCommand: check.command })
    expect(await waitFor(logPath, 'exit code 3')).toContain('goal check failed (exit code 3) for turn turn-9')
  })
})
