import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * Telling the SESSION, in words, which config it runs
 * (docs/specs/config-releases.md, "Telling the session").
 *
 * A config release is served from a read-only directory under
 * `/opt/kortix/config`. `/workspace` is a separate, editable checkout that may
 * be behind the commit the release was built from. Without being told, an
 * agent reads `/workspace/.kortix/opencode`, sees different bytes from the
 * ones it is running, and edits files that change nothing.
 *
 * CHANNEL: the agent's system context, through OpenCode's `instructions`
 * array — the same mechanism `secret-capabilities.ts` uses. Chosen over
 * posting a message into the session because:
 *
 *   - Applying a release RESTARTS OpenCode. `instructions` is composed at
 *     every spawn (`writeComposedConfig`), so it survives the restart the
 *     convergence itself performs; a message posted to the old process does
 *     not.
 *   - It costs no model call and starts no turn. `POST /session/:id/
 *     prompt_async`, the only other in-box channel, would begin a real turn
 *     after every convergence.
 *
 * It is a STATEMENT OF STATE, not an event, so it stays true on every later
 * turn. It names the commit, which is the identity a human checks.
 *
 * The file is rewritten only when its content changes: a convergence that
 * applies a new release rewrites it, and one that changes nothing does not
 * touch it (`'unchanged'`). The flag-off revert clears it.
 */
export const CONFIG_RELEASE_NOTICE_PATH = '/tmp/kortix/config-release.md'

export interface ConfigReleaseNotice {
  /** The commit the running release was built from. */
  sourceCommit: string | null
  /** The repo-relative config dir, e.g. `.kortix/opencode`. */
  configDir: string | null
  /** The session id, for the reload command. */
  sessionId?: string | null
  /** The read-only directory the release is served from, when it is known. */
  releaseDir?: string | null
  /**
   * The API's own sentence about an agent re-point, rendered VERBATIM.
   *
   * The API decides whether a session's agent moved to the project's declared
   * default and writes the sentence that explains it. Paraphrasing it here
   * would make two surfaces disagree about an access decision, and a second
   * channel would tell the session twice. It rides the notice, which is
   * already composed into OpenCode's `instructions` at every spawn and is
   * already written only when its text changes — so this is stated once per
   * change, like the commit line beside it.
   */
  agentRepoint?: string | null
}

/** Commits are named by their first 12 characters, as every Kortix surface does. */
function short(sha: string): string {
  return sha.slice(0, 12)
}

export function renderConfigReleaseNotice(notice: ConfigReleaseNotice): string {
  const commit = notice.sourceCommit ? short(notice.sourceCommit) : null
  const configDir = notice.configDir ?? '.kortix/opencode'
  const reload = notice.sessionId ? `kortix sessions reload ${notice.sessionId}` : 'kortix sessions reload <session id>'
  const at = commit ? ` at commit ${commit}` : ''
  const servedFrom = notice.releaseDir ?? '/opt/kortix/config/<release>'
  const repoint = notice.agentRepoint?.trim()
  return [
    "# This session's agent config",
    '',
    `This session runs the project's agent config from the base branch${at}. The`,
    `platform serves it read-only from \`${servedFrom}\`; it is not the copy in`,
    '`/workspace`.',
    '',
    `- \`/workspace\` is a separate checkout and may be behind${commit ? ` commit ${commit}` : ' the base branch'}.`,
    '  Run `git pull` in `/workspace` to read the same files.',
    `- Editing a file under \`/workspace/${configDir}\` does NOT change the config this`,
    '  session runs. The change takes effect after it is pushed to the base branch.',
    `- Writing into \`${servedFrom}\` fails with a permission error, on purpose.`,
    '  That copy is the platform\'s; edit the project\'s files in `/workspace`.',
    `- \`${reload}\` refreshes the \`/workspace\` checkout and moves this`,
    "  session onto the base branch's current config, in one command.",
    ...(repoint ? ['', '## This session\'s agent', '', repoint] : []),
    '',
  ].join('\n')
}

/**
 * Write the notice, unless the file already says exactly this.
 *
 * `'unchanged'` is the answer for a convergence that changed nothing: the
 * agent must not be told its config just moved when it did not.
 */
export function writeConfigReleaseNotice(
  notice: ConfigReleaseNotice,
  path = CONFIG_RELEASE_NOTICE_PATH,
): 'written' | 'unchanged' {
  const body = renderConfigReleaseNotice(notice)
  try {
    if (readFileSync(path, 'utf8') === body) return 'unchanged'
  } catch {
    // Absent or unreadable: write it.
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, body, { encoding: 'utf8', mode: 0o600 })
  renameSync(tmp, path)
  return 'written'
}

/** No release runs any more: config releases are off for this project. */
export function clearConfigReleaseNotice(path = CONFIG_RELEASE_NOTICE_PATH): void {
  rmSync(path, { force: true })
}

/** The path to declare in OpenCode `instructions`, or null when there is no notice. */
export function configReleaseNoticePath(path = CONFIG_RELEASE_NOTICE_PATH): string | null {
  return existsSync(path) ? path : null
}
