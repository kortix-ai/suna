import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { OPENCODE_HOME } from './opencode'
import { logger } from './logger'

// Durable marker recording that this sandbox already delivered its
// KORTIX_INITIAL_PROMPT. CRITICAL: this MUST live on the persisted container
// disk, not on tmpfs.
//
// The bug it fixes: opening a session in the dashboard wakes a hibernated box
// via `provider.start` (a plain reboot of the SAME VM — see resumeStoppedSandbox
// in apps/api). The box's baked env still carries KORTIX_INITIAL_PROMPT, so the
// agent server re-ran it on every boot and re-answered the original (e.g. a
// day-old Slack) message, in a brand-new opencode session disconnected from the
// live turn stream — looking like the webhook "refired for no reason".
//
// The opencode session pin (OPENCODE_SESSION_PIN_PATH) is NOT a usable guard for
// this: it lives under tmpfs /var/run and is wiped on every reboot, so it can't
// tell a cold first boot apart from a wake. This marker lives under
// OPENCODE_DATA_HOME (persisted), so once the prompt is delivered it stays
// delivered across any number of resumes/restarts. A genuine cold reprovision
// (new box, fresh disk) has no marker and still runs the prompt exactly once.
export const INITIAL_PROMPT_DELIVERED_PATH = `${OPENCODE_HOME}/.local/share/kortix/initial-prompt-delivered`

/** True once this box has delivered its initial prompt (durable across reboots). */
export function initialPromptAlreadyDelivered(path = INITIAL_PROMPT_DELIVERED_PATH): boolean {
  try {
    return existsSync(path)
  } catch {
    return false
  }
}

/** Persist the "initial prompt delivered" marker on the durable disk so a later
 *  wake/reboot never replays KORTIX_INITIAL_PROMPT. Best-effort: a write failure
 *  only risks a duplicate run on the next reboot, never a crash. */
export function markInitialPromptDelivered(path = INITIAL_PROMPT_DELIVERED_PATH): void {
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, new Date().toISOString(), 'utf8')
  } catch (err) {
    logger.warn('[boot] failed to write initial-prompt-delivered marker', err)
  }
}
