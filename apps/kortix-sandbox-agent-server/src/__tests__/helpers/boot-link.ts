import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pointBootLink } from '../../boot-config'

/**
 * The value `KORTIX_BOOT_CONFIG_ROOT` had before any test redirected it, read
 * once when this module loads.
 *
 * The override must not outlive the file that needed it. `bootConfigRoot()`
 * reads that variable on every call, so anything still reading it afterwards —
 * `bootLinkPath()`, and every string `describeOpencodeError` builds from it —
 * answers for a throwaway directory that no longer exists. That is one
 * explanation for the packages lane of CI run 36153691220, where
 * `proven-check-causes.test.ts` read a boot link that was not
 * `/opt/kortix/config/boot`, in a file order no local run reproduced.
 */
const ORIGINAL_BOOT_CONFIG_ROOT = process.env.KORTIX_BOOT_CONFIG_ROOT

/**
 * Point a test's boot link at `dir` inside a throwaway store root.
 *
 * `OPENCODE_CONFIG_DIR` is the boot link and only the boot link
 * (PLAN-one-boot-path T1), so a test that spawns a real OpenCode on a fixture
 * directory has to name that directory the same way production does. Sets
 * `KORTIX_BOOT_CONFIG_ROOT`, so nothing touches `/opt/kortix`.
 *
 * Every file that calls this MUST put `afterAll(restoreTestConfigRoot)` beside
 * it, so the override dies with the file that needed it.
 */
export async function serveTestConfigDir(dir: string, root?: string): Promise<string> {
  const store = root ?? mkdtempSync(join(tmpdir(), 'kortix-boot-link-'))
  process.env.KORTIX_BOOT_CONFIG_ROOT = store
  await pointBootLink(dir, store)
  return store
}

/** Put the boot-config root back the way the process found it. */
export function restoreTestConfigRoot(): void {
  if (ORIGINAL_BOOT_CONFIG_ROOT === undefined) delete process.env.KORTIX_BOOT_CONFIG_ROOT
  else process.env.KORTIX_BOOT_CONFIG_ROOT = ORIGINAL_BOOT_CONFIG_ROOT
}
