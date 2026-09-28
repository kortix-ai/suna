import { bootConfigRoot, pointBootLink, readBootLinkTarget } from '../../boot-config'
import { logger } from '../../logger'

/**
 * THE writer of the boot link (PLAN-one-boot-path T2).
 *
 * `OPENCODE_CONFIG_DIR` is `<boot config root>/boot` and nothing else
 * (lifecycle.ts, tripwire T1), so the only way to change what OpenCode reads is
 * to repoint that link. Every such change goes through this one function, names
 * why it happened, and leaves one line in the daemon log. Before this, the boot
 * path, the fallback chain and a convergence each retargeted OpenCode their own
 * way, and the timeout branch that produced the 2026-09-24 defect changed it
 * silently.
 *
 * The link is an implementation detail of the store, so it is created under the
 * same root the releases live in.
 */
export async function serveConfigDir(dir: string, why: string, root: string = bootConfigRoot()): Promise<void> {
  const previous = await readBootLinkTarget(root)
  await pointBootLink(dir, root)
  logger.info('[boot-link] opencode now reads', { dir, previous, why })
}

/** The directory OpenCode reads right now, or null before the link exists. */
export function servingConfigDir(root: string = bootConfigRoot()): Promise<string | null> {
  return readBootLinkTarget(root)
}
