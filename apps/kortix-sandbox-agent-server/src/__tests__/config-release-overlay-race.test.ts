/**
 * DEF-5 (verification 2026-09-22): ~15% of fresh boots restarted OpenCode
 * 1–6 s after ready with 'the running release no longer verifies; rebuilding'.
 *
 * A project sandbox has no baked managed-skill overlay. The first
 * runtime-assets pass after ready writes /opt/kortix/managed-skills and
 * injects it into the running release. The convergence after ready verifies
 * the same release at the same moment. `verifyRelease` reads the overlay's
 * names, then walks the release: a walk that sees an injected skill the names
 * did not include reports an ADDED file.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { materializeRelease, verifyRelease, verifyReleaseDetail, type ReleaseManifest } from '@/services/config-provider/boot-config'
import { overlayHash, reconcileRuntimeAssets, resetRuntimeConvergenceForTests } from '@/services/runtime-assets/runtime-assets'
import { buildRelease, commitAll, initRepo, write, type BuiltRelease } from './helpers/config-release-fixtures'

const REL = '.kortix/opencode'
let root: string
let repo: string
let store: string
let overlay: string

const OVERLAY_FILES = [
  { path: 'kortix-apps/SKILL.md', content: 'APPS v2\n' },
  { path: 'kortix-cli/SKILL.md', content: 'CLI v2\n' },
  { path: 'kortix-system/SKILL.md', content: 'SYSTEM v2\n' },
]

function manifestOf(release: BuiltRelease): ReleaseManifest {
  const d = release.descriptor
  return {
    release_id: d.release_id!,
    source_commit: d.source_commit!,
    config_dir: REL,
    config_tree_id: d.config_tree_id!,
    archive_url: d.archive!.url,
    archive_bytes: d.archive!.bytes,
    files: d.files!,
    compiled_governance: d.compiled_governance,
    compiled_governance_etag: d.compiled_governance_etag,
  }
}

/** The old-starter shape: a tracked, stale kortix-cli skill. No baked overlay on the box. */
async function oldStarterRelease() {
  initRepo(repo)
  write(repo, `${REL}/opencode.jsonc`, '{}\n')
  write(repo, `${REL}/agents/kortix.md`, 'PROMPT\n')
  write(repo, `${REL}/skills/pdf/SKILL.md`, 'PDF\n')
  write(repo, `${REL}/skills/kortix-cli/SKILL.md`, 'STALE TRACKED COPY\n')
  const built = buildRelease(repo, commitAll(repo, 'old starter'), {})
  const { dir } = await materializeRelease({
    root: store,
    manifest: manifestOf(built),
    archive: built.archive,
    managedSkillsDir: overlay, // absent: the project image bakes none
  })
  // `dir` is the OpenCode config dir inside the release; `releaseRoot` is the checkout.
  return { built, dir: join(dir, REL), releaseRoot: dir }
}

function stubApi() {
  const hash = overlayHash(OVERLAY_FILES)
  return (async (input: string | URL | Request) => {
    const url = String(input)
    if (url.endsWith('/runtime-assets/manifest')) return Response.json({ managed_skills_hash: hash })
    if (url.endsWith('/runtime-assets/managed-skills')) return Response.json({ hash, files: OVERLAY_FILES })
    return new Response('nope', { status: 404 })
  }) as unknown as typeof fetch
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'overlay-race-'))
  repo = join(root, 'repo')
  store = join(root, 'store')
  overlay = join(root, 'opt', 'managed-skills')
})

afterEach(() => {
  resetRuntimeConvergenceForTests()
  spawnSync('chmod', ['-R', 'u+w', root])
  rmSync(root, { recursive: true, force: true })
})

describe('DEF-5: the overlay pass and release verification', () => {
  test('a verification failure names the file and the overlay names it used', async () => {
    const { built, dir, releaseRoot } = await oldStarterRelease()
    // `seal` now closes the release root and `skills/`, so only the overlay
    // pass can create an entry there (it unseals and reseals). This test is
    // about the verification MESSAGE, so it opens the same doors the overlay
    // does to reach the state DEF-5 described.
    spawnSync('chmod', ['u+w', dir, join(dir, 'skills')])
    write(dir, 'skills/kortix-apps/SKILL.md', 'INJECTED\n')
    const detail = await verifyReleaseDetail({ dir: releaseRoot, files: built.descriptor.files!, configDir: REL, managedSkillsDir: overlay })
    expect(detail).toEqual({
      ok: false,
      problem: `${REL}/skills/kortix-apps/SKILL.md is not in the release (managed overlay names: 0)`,
    })
  })
})
