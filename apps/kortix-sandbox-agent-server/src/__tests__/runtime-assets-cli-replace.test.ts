/**
 * Replacing the CLI the platform owns.
 *
 * `replaceCli` writes a temp file NEXT TO /usr/local/bin/kortix and renames it
 * into place — rename(2) is only atomic within one filesystem, so the temp file
 * has to live in that directory. Both the create and the rename take their
 * permission from the DIRECTORY. In the shipped image that directory is
 * root-owned while the daemon runs as `kortix`, so every convergence that
 * actually had to write failed EACCES and the box reported
 * `components.cli: failed` — observed on a fresh Platinum box before its own
 * self-update. Owning the FILE (COPY --chown) never helped.
 *
 * The image now hands `kortix` the directory (platform-binaries.ts). Boxes
 * already running an older snapshot cannot wait for a rebuild, so the daemon
 * also unlocks the directory once and retries. These tests reproduce the real
 * failure with a real unwritable directory — no mocked fs.
 *
 * The candidates here are REAL executable shell scripts, not text, so the
 * default exec probe genuinely runs them. That is the second property this
 * function carries: a candidate that does not execute never reaches the live
 * path, and that failure is not a permission failure.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { chmod, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { replaceCli } from '../runtime-assets'

const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex')

/** A candidate that really runs and exits with `code`. */
const script = (code: number) => Buffer.from(`#!/bin/sh\nexit ${code}\n`)

const RUNNABLE = script(0)
const UNRUNNABLE = script(3)

const dirs: string[] = []

async function lockedDir(installed: string) {
  const root = await mkdtemp(join(tmpdir(), 'cli-replace-'))
  dirs.push(root)
  const dir = join(root, 'usr-local-bin')
  await Bun.write(join(dir, 'kortix'), installed)
  const cliPath = join(dir, 'kortix')
  return { dir, cliPath }
}

afterEach(async () => {
  while (dirs.length > 0) {
    const d = dirs.pop() as string
    await chmod(join(d, 'usr-local-bin'), 0o755).catch(() => {})
    await rm(d, { recursive: true, force: true })
  }
})

describe('replaceCli', () => {
  test('replaces the binary atomically when the directory is writable', async () => {
    const { cliPath } = await lockedDir('OLD')
    expect(await replaceCli(cliPath, sha(RUNNABLE), RUNNABLE.buffer as ArrayBuffer)).toBe('updated')
    expect(await readFile(cliPath, 'utf8')).toBe(RUNNABLE.toString())
  })

  test('keeps the installed binary when the download digest does not match', async () => {
    const { cliPath } = await lockedDir('OLD')
    expect(
      await replaceCli(cliPath, sha('SOMETHING ELSE'), RUNNABLE.buffer as ArrayBuffer),
    ).toBe('failed')
    expect(await readFile(cliPath, 'utf8')).toBe('OLD')
  })

  test('a digest mismatch never creates a temp file in the directory', async () => {
    const { dir, cliPath } = await lockedDir('OLD')
    expect(
      await replaceCli(cliPath, sha('SOMETHING ELSE'), RUNNABLE.buffer as ArrayBuffer),
    ).toBe('failed')
    expect(await Array.fromAsync(new Bun.Glob('.kortix.download.*').scan(dir))).toEqual([])
  })

  test('a candidate that does not run never reaches the live path', async () => {
    const { dir, cliPath } = await lockedDir('OLD')
    expect(
      await replaceCli(cliPath, sha(UNRUNNABLE), UNRUNNABLE.buffer as ArrayBuffer),
    ).toBe('unrunnable')
    expect(await readFile(cliPath, 'utf8')).toBe('OLD')
    expect(await Array.fromAsync(new Bun.Glob('.kortix.download.*').scan(dir))).toEqual([])
  })

  test('an unrunnable candidate is not escalated as a permission failure', async () => {
    // The temp file was already created and chmod'd, so the directory was
    // writable. Unlocking it again cannot make this binary execute.
    const { cliPath } = await lockedDir('OLD')
    let unlocked = 0
    const reasons: string[] = []
    expect(
      await replaceCli(cliPath, sha(UNRUNNABLE), UNRUNNABLE.buffer as ArrayBuffer, {
        unlockDir: async () => {
          unlocked++
          return true
        },
        onUnlockAttempt: (r) => reasons.push(r),
      }),
    ).toBe('unrunnable')
    expect(unlocked).toBe(0)
    expect(reasons).toEqual([])
  })

  test('fails on a directory it cannot write, and says the directory is why', async () => {
    const { dir, cliPath } = await lockedDir('OLD')
    await chmod(dir, 0o555)
    const reasons: string[] = []
    expect(
      await replaceCli(cliPath, sha(RUNNABLE), RUNNABLE.buffer as ArrayBuffer, {
        unlockDir: async () => false,
        onUnlockAttempt: (r) => reasons.push(r),
      }),
    ).toBe('failed')
    expect(await readFile(cliPath, 'utf8')).toBe('OLD')
    expect(reasons.join(' ')).toMatch(/EACCES|EPERM/)
  })

  test('unlocks the directory once and retries — an older image heals itself', async () => {
    const { dir, cliPath } = await lockedDir('OLD')
    await chmod(dir, 0o555)
    let unlocked = 0
    expect(
      await replaceCli(cliPath, sha(RUNNABLE), RUNNABLE.buffer as ArrayBuffer, {
        unlockDir: async (target) => {
          unlocked++
          await chmod(target, 0o755)
          return true
        },
      }),
    ).toBe('updated')
    expect(unlocked).toBe(1)
    expect(await readFile(cliPath, 'utf8')).toBe(RUNNABLE.toString())
  })

  test('does not retry forever: one unlock attempt, then it gives up', async () => {
    const { dir, cliPath } = await lockedDir('OLD')
    await chmod(dir, 0o555)
    let unlocked = 0
    expect(
      await replaceCli(cliPath, sha(RUNNABLE), RUNNABLE.buffer as ArrayBuffer, {
        unlockDir: async () => {
          unlocked++
          return true // claims success but changes nothing
        },
      }),
    ).toBe('failed')
    expect(unlocked).toBe(1)
    expect(await readFile(cliPath, 'utf8')).toBe('OLD')
  })
})
