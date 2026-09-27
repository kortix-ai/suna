/**
 * The session notice (docs/specs/config-releases.md, "Telling the session").
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
  configReleaseNoticePath,
  renderConfigReleaseNotice,
  writeConfigReleaseNotice,
} from '../config-release/notice'

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
      configDir: '.kortix/opencode',
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
  })

  test('names the read-only directory, so a permission error explains itself', () => {
    // Measured on a real box: an agent writing into the release dir gets a
    // bare `PermissionDenied: FileSystem.writeFile (/opt/kortix/config/<64
    // hex>/…)`. That is opaque alone; naming the path here is what lets the
    // agent say why and where to write instead.
    const body = renderConfigReleaseNotice({
      sourceCommit: COMMIT,
      configDir: '.kortix/opencode',
      releaseDir: '/opt/kortix/config/abc123',
    })
    expect(body).toContain('read-only from `/opt/kortix/config/abc123`')
    expect(body).toContain('fails with a permission error, on purpose')
  })

  test('without a known release dir it still names the store, never "null"', () => {
    const body = renderConfigReleaseNotice({ sourceCommit: COMMIT, configDir: null })
    expect(body).toContain('/opt/kortix/config/<release>')
    expect(body).not.toContain('null')
    expect(body).not.toContain('undefined')
  })

  test('stays factual when the commit or the session id is unknown', () => {
    const body = renderConfigReleaseNotice({ sourceCommit: null, configDir: null })
    expect(body).toContain('may be behind the base branch')
    expect(body).toContain('kortix sessions reload <session id>')
    expect(body).toContain('.kortix/opencode')
    expect(body).not.toContain('commit null')
    expect(body).not.toContain('undefined')
  })

  test('names the project config dir when the manifest moved it', () => {
    const body = renderConfigReleaseNotice({ sourceCommit: COMMIT, configDir: 'config/agents' })
    expect(body).toContain('/workspace/config/agents')
  })
})

describe('writing it', () => {
  test('a converged session is told once, with the right commit', () => {
    expect(writeConfigReleaseNotice({ sourceCommit: COMMIT, configDir: '.kortix/opencode' }, path)).toBe('written')
    expect(readFileSync(path, 'utf8')).toContain('commit 1234567890ab')
    expect(configReleaseNoticePath(path)).toBe(path)
  })

  test('an unchanged convergence writes nothing at all', () => {
    const notice = { sourceCommit: COMMIT, configDir: '.kortix/opencode' }
    writeConfigReleaseNotice(notice, path)
    const before = statSync(path).mtimeMs
    expect(writeConfigReleaseNotice(notice, path)).toBe('unchanged')
    expect(statSync(path).mtimeMs).toBe(before)
  })

  test('a new release rewrites it with the new commit', () => {
    writeConfigReleaseNotice({ sourceCommit: COMMIT, configDir: '.kortix/opencode' }, path)
    const next = 'fedcba9876543210fedcba9876543210fedcba98'
    expect(writeConfigReleaseNotice({ sourceCommit: next, configDir: '.kortix/opencode' }, path)).toBe('written')
    const body = readFileSync(path, 'utf8')
    expect(body).toContain('commit fedcba987654')
    expect(body).not.toContain('1234567890ab')
  })

  test('clearing it removes the file and the instruction path', () => {
    writeConfigReleaseNotice({ sourceCommit: COMMIT, configDir: '.kortix/opencode' }, path)
    clearConfigReleaseNotice(path)
    expect(existsSync(path)).toBe(false)
    expect(configReleaseNoticePath(path)).toBeNull()
    // Clearing twice is not an error.
    clearConfigReleaseNotice(path)
  })
})
