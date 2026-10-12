import { readFile, readdir } from 'node:fs/promises'

import { runGit } from '../git/git'
import { PROJECT_SNAPSHOT_FORMAT, PROJECT_SNAPSHOT_MARKER_PATH, type ProjectSnapshotDescriptor } from './contract'
import { ProjectSnapshotError } from './errors'

const GIT_CONFIG_FORBIDDEN_RE =
  /^\s*\[(remote|credential|include|includeif|filter|url)\b|^\s*(hookspath|fsmonitor|sshcommand|askpass|gitproxy|pager|editor)\s*=/im

/**
 * The extracted stage must be the exact revision the pin named, and its `.git`
 * must not be able to run anything: no hooks (rejected by the guard), no
 * filters / remotes / includes in `.git/config`, and its pack must carry the
 * promisor mark the partial-clone contract relies on. Only plumbing
 * (`rev-parse`) touches the stage before activation — and it needs no blob.
 */
export async function verifyExtractedProjectSnapshot(
  stage: string,
  descriptor: ProjectSnapshotDescriptor,
): Promise<void> {
  let marker: { format?: string; commit_sha?: string; repository?: { external_id?: string } }
  try {
    marker = JSON.parse(await readFile(`${stage}/${PROJECT_SNAPSHOT_MARKER_PATH}`, 'utf8'))
  } catch (err) {
    throw new ProjectSnapshotError('verify', 'malformed', 'archive carries no readable snapshot marker', 0, { cause: err })
  }
  if (
    marker.format !== PROJECT_SNAPSHOT_FORMAT ||
    marker.commit_sha !== descriptor.commit_sha ||
    marker.repository?.external_id !== descriptor.repository.external_id
  ) {
    throw new ProjectSnapshotError('verify', 'revision-mismatch', 'snapshot marker does not match the descriptor')
  }
  let gitConfig = ''
  try {
    gitConfig = await readFile(`${stage}/.git/config`, 'utf8')
  } catch (err) {
    throw new ProjectSnapshotError('verify', 'malformed', 'archive carries no .git/config', 0, { cause: err })
  }
  const forbidden = gitConfig.match(GIT_CONFIG_FORBIDDEN_RE)
  if (forbidden) {
    throw new ProjectSnapshotError('verify', 'malformed', `archive .git/config carries a forbidden setting: ${forbidden[0].trim()}`)
  }
  let packs: string[] = []
  try {
    packs = await readdir(`${stage}/.git/objects/pack`)
  } catch {
    packs = []
  }
  if (!packs.some((n) => n.endsWith('.pack')) || !packs.some((n) => n.endsWith('.promisor'))) {
    throw new ProjectSnapshotError('verify', 'malformed', 'snapshot .git carries no promisor-marked pack')
  }
  const head = await runGit(['-C', stage, 'rev-parse', '--verify', 'HEAD'])
  const sha = head.stdout.trim()
  if (head.code !== 0 || sha !== descriptor.commit_sha) {
    throw new ProjectSnapshotError('verify', 'revision-mismatch', `extracted HEAD is ${sha || head.stderr.trim() || 'unreadable'}, expected ${descriptor.commit_sha}`)
  }
}
