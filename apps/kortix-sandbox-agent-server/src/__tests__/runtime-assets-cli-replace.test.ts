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
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { replaceCli } from '../runtime-assets'

const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex')

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
    const next = Buffer.from('NEW')
    expect(await replaceCli(cliPath, sha(next), next.buffer as ArrayBuffer)).toBe('updated')
    expect(await readFile(cliPath, 'utf8')).toBe('NEW')
  })

  test('keeps the installed binary when the download digest does not match', async () => {
    const { cliPath } = await lockedDir('OLD')
    const next = Buffer.from('NEW')
    expect(await replaceCli(cliPath, sha('SOMETHING ELSE'), next.buffer as ArrayBuffer)).toBe(
      'failed',
    )
    expect(await readFile(cliPath, 'utf8')).toBe('OLD')
  })

  test('fails on a directory it cannot write, and says the directory is why', async () => {
    const { dir, cliPath } = await lockedDir('OLD')
    await chmod(dir, 0o555)
    const next = Buffer.from('NEW')
    const reasons: string[] = []
    expect(
      await replaceCli(cliPath, sha(next), next.buffer as ArrayBuffer, {
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
    const next = Buffer.from('NEW')
    let unlocked = 0
    expect(
      await replaceCli(cliPath, sha(next), next.buffer as ArrayBuffer, {
        unlockDir: async (target) => {
          unlocked++
          await chmod(target, 0o755)
          return true
        },
      }),
    ).toBe('updated')
    expect(unlocked).toBe(1)
    expect(await readFile(cliPath, 'utf8')).toBe('NEW')
  })

  test('does not retry forever: one unlock attempt, then it gives up', async () => {
    const { dir, cliPath } = await lockedDir('OLD')
    await chmod(dir, 0o555)
    const next = Buffer.from('NEW')
    let unlocked = 0
    expect(
      await replaceCli(cliPath, sha(next), next.buffer as ArrayBuffer, {
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
