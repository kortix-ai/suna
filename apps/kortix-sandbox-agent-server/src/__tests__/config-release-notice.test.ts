/**
 * The session notice.
 *
 * The agent must be told, in words, which commit's config it runs and that
 * `/workspace` is a separate checkout. It must be told exactly once per
 * convergence that changed something, and never re-told when nothing moved.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  clearConfigReleaseNotice,
  manifestIssuesOf,
  renderConfigReleaseNotice,
  writeConfigReleaseNotice,
} from '@/services/config-provider/notice'
import { PI_RELEASE_SOURCE_PATHS } from '@/harness/pi/config-release'

const COMMIT = '1234567890abcdef1234567890abcdef12345678'
let dir: string
let path: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kortix-notice-'))
  path = join(dir, 'config-release.md')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('the notice text', () => {
  test('names the commit, the checkout, and both ways to catch up', () => {
    const body = renderConfigReleaseNotice({
      sourceCommit: COMMIT,
      sourcePaths: PI_RELEASE_SOURCE_PATHS,
      sessionId: 'ses-1',
    })
    expect(body).toContain('commit 1234567890ab')
    // The full SHA is not the identity a human checks; the short one is.
    expect(body).not.toContain(COMMIT)
    expect(body).toContain('`/workspace` is a separate checkout')
    expect(body).toContain('git pull')
    expect(body).toContain('kortix sessions reload ses-1')
    expect(body).toContain('does NOT change the config this')
    expect(body).toContain('pushed to the base branch')
    expect(body).toContain('commit and push a session branch and open a change request')
    expect(body).toContain('Review the Git diff of those source files')
    expect(body).toContain('no reverse mapping to kortix.yaml')
  })

  test('names the read-only directory, so a permission error explains itself', () => {
    // Measured on a real box: an agent writing into the release dir gets a
    // bare `PermissionDenied: FileSystem.writeFile (/opt/kortix/config/<64
    // hex>/…)`. That is opaque alone; naming the path here is what lets the
    // agent say why and where to write instead.
    const body = renderConfigReleaseNotice({
      sourceCommit: COMMIT,
      sourcePaths: PI_RELEASE_SOURCE_PATHS,
      releaseDir: '/opt/kortix/config/abc123',
    })
    expect(body).toContain('read-only from `/opt/kortix/config/abc123`')
    expect(body).toContain('fails with a permission error, on purpose')
  })

  test('without a known release dir it still names the store, never "null"', () => {
    const body = renderConfigReleaseNotice({ sourceCommit: COMMIT, sourcePaths: PI_RELEASE_SOURCE_PATHS })
    expect(body).toContain('/opt/kortix/config/<release>')
    expect(body).not.toContain('null')
    expect(body).not.toContain('undefined')
  })

  test('stays factual when the commit or the session id is unknown', () => {
    const body = renderConfigReleaseNotice({ sourceCommit: null, sourcePaths: PI_RELEASE_SOURCE_PATHS })
    expect(body).toContain('may be behind the base branch')
    expect(body).toContain('kortix sessions reload <session id>')
    expect(body).toContain('`/workspace/agents`, `/workspace/skills` or `/workspace/AGENTS.md`')
    expect(body).not.toContain('commit null')
    expect(body).not.toContain('undefined')
  })

  test('names the manifest as the editable source for a root-layout project', () => {
    const body = renderConfigReleaseNotice({ sourceCommit: COMMIT, sourcePaths: PI_RELEASE_SOURCE_PATHS })
    expect(body).toContain('`/workspace/kortix.yaml`')
    expect(body).toContain('`/workspace/agents`')
    expect(body).toContain('`/workspace/skills`')
  })
})

describe('kortix.yaml issues (manifest_issues)', () => {
  const ISSUES = manifestIssuesOf({
    schema: 3,
    manifest_issues: [
      { path: 'agents.writer.model', message: 'Unknown model "x".\nPick one from `kortix models`.', severity: 'error', line: 12, column: 5 },
      { path: 'kortix_version', message: '`kortix_version` is obsolete and ignored. Remove it.', severity: 'warning', line: 1, column: 1 },
      { path: 'agents.reviewer', message: 'A warning with no position.', severity: 'warning' },
      { path: 'not.an.issue', severity: 'fatal' },
    ],
  })

  test('lists each issue as file:line:col severity path message, with the rule and the fix', () => {
    const body = renderConfigReleaseNotice({ sourceCommit: COMMIT, sourcePaths: PI_RELEASE_SOURCE_PATHS, manifestIssues: ISSUES })
    expect(body).toContain('## kortix.yaml has issues')
    expect(body).toContain('kortix.yaml on the base branch has 1 error and 2 warnings:')
    expect(body).toContain('- kortix.yaml:12:5 error agents.writer.model Unknown model "x". Pick one from `kortix models`.')
    expect(body).toContain('- kortix.yaml:1:1 warning kortix_version `kortix_version` is obsolete and ignored. Remove it.')
    expect(body).toContain('- kortix.yaml warning agents.reviewer A warning with no position.')
    // An entry of another shape is skipped, never rendered.
    expect(body).not.toContain('not.an.issue')
    expect(body).toContain('An agent or trigger with an error is off until the error is fixed.')
    expect(body).toContain('run `kortix validate`')
    expect(body).toContain('open a change request against the base branch')
  })

  test('no issues, or an API that sends none: no section', () => {
    for (const set of [{ schema: 3, manifest_issues: [] }, { schema: 3 }, null]) {
      const body = renderConfigReleaseNotice({ sourceCommit: COMMIT, sourcePaths: PI_RELEASE_SOURCE_PATHS, manifestIssues: manifestIssuesOf(set) })
      expect(body).not.toContain('kortix.yaml has issues')
      expect(body).not.toContain('kortix validate')
    }
  })

  test('a change in the issues rewrites the notice; the same issues do not', () => {
    const notice = { sourceCommit: COMMIT, sourcePaths: PI_RELEASE_SOURCE_PATHS, manifestIssues: ISSUES }
    expect(writeConfigReleaseNotice(notice, path)).toBe('written')
    expect(writeConfigReleaseNotice(notice, path)).toBe('unchanged')
    expect(writeConfigReleaseNotice({ ...notice, manifestIssues: [] }, path)).toBe('written')
    expect(readFileSync(path, 'utf8')).not.toContain('kortix.yaml has issues')
  })
})

describe('writing it', () => {
  test('a converged session is told once, with the right commit', () => {
    expect(writeConfigReleaseNotice({ sourceCommit: COMMIT, sourcePaths: PI_RELEASE_SOURCE_PATHS }, path)).toBe('written')
    expect(readFileSync(path, 'utf8')).toContain('commit 1234567890ab')
  })

  test('an unchanged convergence writes nothing at all', () => {
    const notice = { sourceCommit: COMMIT, sourcePaths: PI_RELEASE_SOURCE_PATHS }
    writeConfigReleaseNotice(notice, path)
    const before = statSync(path).mtimeMs
    expect(writeConfigReleaseNotice(notice, path)).toBe('unchanged')
    expect(statSync(path).mtimeMs).toBe(before)
  })

  test('a new release rewrites it with the new commit', () => {
    writeConfigReleaseNotice({ sourceCommit: COMMIT, sourcePaths: PI_RELEASE_SOURCE_PATHS }, path)
    const next = 'fedcba9876543210fedcba9876543210fedcba98'
    expect(writeConfigReleaseNotice({ sourceCommit: next, sourcePaths: PI_RELEASE_SOURCE_PATHS }, path)).toBe('written')
    const body = readFileSync(path, 'utf8')
    expect(body).toContain('commit fedcba987654')
    expect(body).not.toContain('1234567890ab')
  })

  test('clearing it removes the file and the instruction path', () => {
    writeConfigReleaseNotice({ sourceCommit: COMMIT, sourcePaths: PI_RELEASE_SOURCE_PATHS }, path)
    clearConfigReleaseNotice(path)
    expect(existsSync(path)).toBe(false)
    // Clearing twice is not an error.
    clearConfigReleaseNotice(path)
  })
})
