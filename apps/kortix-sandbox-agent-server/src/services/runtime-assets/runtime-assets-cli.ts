import { chmod, mkdir, mkdtemp, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { logger } from '@/lib/log/logger'
import { defaultExecProbe, verifyArtifact } from './runtime-assets'
import type { ExecProbe } from './runtime-assets'

async function sudoOwnDir(dir: string): Promise<boolean> {
  try {
    const uid = process.getuid?.() ?? 0
    const gid = process.getgid?.() ?? 0
    const proc = Bun.spawn(['sudo', '-n', 'chown', `${uid}:${gid}`, dir], {
      stdout: 'ignore',
      stderr: 'ignore',
      stdin: 'ignore',
    })
    return (await proc.exited) === 0
  } catch {
    return false
  }
}

export interface ReplaceCliDeps {
  /** Seam for the escalation. Returns true when it believes it changed something. */
  unlockDir?: (dir: string) => Promise<boolean>
  /** Seam for observing the first failure's reason. */
  onUnlockAttempt?: (reason: string) => void
  /**
   * Runs the candidate before it replaces a working binary. See {@link ExecProbe}.
   *
   * Optional and defaulted to the REAL spawn on purpose: a caller that forgets
   * it still gets the proof, and a test that wants a different answer has to say
   * so out loud.
   */
  execProbe?: ExecProbe
}

/**
 * Install a verified CLI binary at `cliPath`.
 *
 * Three properties, in this order, and each one is load-bearing:
 *
 *  1. VERIFY BEFORE TOUCHING THE FILESYSTEM. A digest mismatch must not even
 *     create a temp file, and it must never be reported through the same path
 *     as a permission failure.
 *  2. RUN THE CANDIDATE BEFORE THE RENAME. The binary is executed from the temp
 *     path, so a wrong-arch or truncated artifact never reaches
 *     `/usr/local/bin/kortix` and the box keeps the CLI it had.
 *  3. UNLOCK THE DIRECTORY ONCE AND RETRY. The temp-file create and the rename
 *     both draw their permission from the DIRECTORY, which is root-owned on an
 *     older snapshot while the daemon runs as `kortix`.
 *
 * A failed probe is NOT escalated. The temp file was already created and
 * chmod'd by then, so the directory was writable; unlocking it again cannot
 * make a binary that does not execute execute.
 *
 * Exported for `runtime-assets-cli-replace.test.ts`, which drives it against a
 * REAL unwritable directory — the permission failure this function has to
 * survive is a property of the filesystem, not of a mock.
 */
export async function replaceCli(
  cliPath: string,
  expectedSha: string,
  body: Uint8Array,
  deps: ReplaceCliDeps = {},
): Promise<'updated' | 'failed' | 'unrunnable'> {
  // Buffered, not streamed. `Bun.write(path, response)` hangs on a streamed
  // Response in this runtime (a known incident in this repo), and a
  // hash-while-streaming pipeline is more machinery than the numbers justify:
  // the binary is ~100 MB on a sandbox with at least 4 GB, the buffer is
  // transient, and the reconcile runs at most once per session start.
  const bytes = body
  // Verify BEFORE touching the filesystem: a digest mismatch must not even
  // create a temp file, and it must not be mistaken for a permission problem.
  if (!verifyArtifact(bytes, expectedSha)) {
    logger.warn('[runtime-assets] CLI download digest mismatch — keeping the installed binary', {
      expected: expectedSha,
    })
    return 'failed'
  }

  const probe = deps.execProbe ?? defaultExecProbe
  const dir = dirname(cliPath)
  const attempt = async (): Promise<'updated' | 'unrunnable' | string> => {
    // Same directory as the target: `rename` is only atomic within one
    // filesystem, and a cross-device temp file would fail with EXDEV.
    const tmpPath = join(
      dir,
      `.kortix.download.${process.pid}.${Math.random().toString(36).slice(2, 10)}`,
    )
    try {
      await writeFile(tmpPath, bytes)
      await chmod(tmpPath, 0o755)
      // RUN IT FIRST. See {@link ExecProbe} for why this is an exit code and
      // not a version-string comparison.
      const code = await probe(tmpPath, ['--version'])
      if (code !== 0) {
        logger.warn('[runtime-assets] CLI candidate did not run — keeping the installed binary', {
          exitCode: code,
          expected: expectedSha.slice(0, 12),
        })
        return 'unrunnable'
      }
      // Atomic on Linux: a `kortix` already running keeps its open inode, and no
      // caller can ever observe a half-written binary at this path.
      await rename(tmpPath, cliPath)
      return 'updated'
    } catch (err) {
      return String(err)
    } finally {
      await rm(tmpPath, { force: true }).catch(() => {})
    }
  }

  const first = await attempt()
  if (first === 'updated') return 'updated'
  // The candidate reached the probe, so the directory was writable. Escalating
  // would unlock a directory that is not the problem and then run the same
  // unrunnable binary a second time.
  if (first === 'unrunnable') return 'unrunnable'
  deps.onUnlockAttempt?.(first)

  // Both the temp-file create and the rename draw their permission from the
  // DIRECTORY, so this is the only failure worth escalating for. Exactly one
  // retry: if unlocking did not actually help, retrying again never will.
  const unlock = deps.unlockDir ?? sudoOwnDir
  if (!(await unlock(dir))) {
    logger.warn('[runtime-assets] CLI replace failed and the directory could not be unlocked', {
      dir,
      err: first,
    })
    return 'failed'
  }
  const second = await attempt()
  if (second === 'updated') {
    logger.info('[runtime-assets] CLI replaced after unlocking its directory', { dir })
    return 'updated'
  }
  if (second === 'unrunnable') return 'unrunnable'
  logger.warn('[runtime-assets] CLI replace failed', { dir, err: second })
  return 'failed'
}
