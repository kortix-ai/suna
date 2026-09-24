import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pointBootLink } from '../../boot-config'

/**
 * Point a test's boot link at `dir` inside a throwaway store root.
 *
 * `OPENCODE_CONFIG_DIR` is the boot link and only the boot link
 * (PLAN-one-boot-path T1), so a test that spawns a real OpenCode on a fixture
 * directory has to name that directory the same way production does. Sets
 * `KORTIX_BOOT_CONFIG_ROOT`, so nothing touches `/opt/kortix`.
 */
export async function serveTestConfigDir(dir: string, root?: string): Promise<string> {
  const store = root ?? mkdtempSync(join(tmpdir(), 'kortix-boot-link-'))
  process.env.KORTIX_BOOT_CONFIG_ROOT = store
  await pointBootLink(dir, store)
  return store
}
