/**
 * The config release store, OUTSIDE the repository.
 *
 * A release is built from the archive the API serves and verified file by file
 * against the Git blob IDs in the descriptor. The archive store is untrusted
 * transport, so a changed byte, a missing file or an extra file is refused.
 * Real repositories and real `git archive | gzip -n` output; nothing mocks Git.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import {
  accessSync,
  chmodSync,
  constants,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { ensureInjectedManagedSkills } from '../managed-skills'
import {
  activateBootConfig,
  bootLinkPath,
  deactivateBootConfig,
  extractConfigArchive,
  materializeRelease,
  pointBootLink,
  pruneBootConfigs,
  quarantineRelease,
  readBootConfigPointer,
  readQuarantine,
  readReleaseManifest,
  releaseDir,
  verifyRelease,
  type ReleaseManifest,
} from '../boot-config'
import { buildRelease, commitAll, git, initRepo, write, type BuiltRelease } from './helpers/config-release-fixtures'

const REL = '.kortix/opencode'
let root: string
let repo: string
let store: string
let overlay: string

function manifestOf(release: BuiltRelease): ReleaseManifest {
  const d = release.descriptor
  return {
    release_id: d.release_id!,
    source_commit: d.source_commit!,
    config_dir: d.config_dir!,
    config_tree_id: d.config_tree_id!,
    archive_url: d.archive!.url,
    archive_bytes: d.archive!.bytes,
    files: d.files!,
    compiled_governance: d.compiled_governance,
    compiled_governance_etag: d.compiled_governance_etag,
  }
}

function release(message: string, governance: string | null = null): BuiltRelease {
  return buildRelease(repo, commitAll(repo, message), REL, { governance })
}

async function materialize(built: BuiltRelease, prepare?: (dir: string) => Promise<void>) {
  return materializeRelease({ root: store, manifest: manifestOf(built), archive: built.archive, prepare, managedSkillsDir: overlay })
}

const verify = (built: BuiltRelease, dir: string) =>
  verifyRelease({ dir, files: built.descriptor.files!, managedSkillsDir: overlay })

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kortix-release-store-'))
  repo = join(root, 'repo')
  store = join(root, 'store')
  overlay = join(root, 'managed-skills')
  initRepo(repo)
  write(overlay, 'kortix-cli/SKILL.md', 'OVERLAY\n')
  write(repo, `${REL}/opencode.jsonc`, '{}\n')
  write(repo, `${REL}/agents/kortix.md`, 'PROMPT v1\n')
  write(repo, `${REL}/skills/pdf/SKILL.md`, 'PDF\n')
  write(repo, `${REL}/skills/pdf/scripts/run.sh`, '#!/bin/sh\necho hi\n')
  chmodSync(join(repo, `${REL}/skills/pdf/scripts/run.sh`), 0o755)
  write(repo, `${REL}/skills/kortix-cli/SKILL.md`, 'STALE REPO COPY\n')
  write(repo, `${REL}/package.json`, '{"dependencies":{"@opencode-ai/plugin":"1.17.11"}}\n')
  write(repo, 'app.ts', 'export const x = 1\n')
})

afterEach(() => {
  spawnSync('chmod', ['-R', 'u+w', root])
  rmSync(root, { recursive: true, force: true })
})

describe('materializeRelease', () => {
  test('builds <root>/<release_id> from the archive with exactly the listed files', async () => {
    const built = release('v1')
    const { dir } = await materialize(built)
    expect(dir).toBe(join(store, built.descriptor.release_id!))
    expect(readFileSync(join(dir, 'agents/kortix.md'), 'utf8')).toBe('PROMPT v1\n')
    expect(existsSync(join(dir, 'app.ts'))).toBe(false)
    expect(await verify(built, dir)).toBe(true)
    expect(await readReleaseManifest(store, built.descriptor.release_id!)).toEqual(manifestOf(built))
  })

  test('it never writes the repository', async () => {
    const built = release('v1')
    const head = git(repo, 'rev-parse', 'HEAD')
    await materialize(built)
    expect(git(repo, 'status', '--porcelain')).toBe('')
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(head)
  })

  test('project files are read-only; an executable keeps its execute bit', async () => {
    const { dir } = await materialize(release('v1'))
    expect(() => accessSync(join(dir, 'agents/kortix.md'), constants.W_OK)).toThrow()
    expect(() => writeFileSync(join(dir, 'agents/kortix.md'), 'EDIT\n')).toThrow()
    accessSync(join(dir, 'skills/pdf/scripts/run.sh'), constants.X_OK)
  })

  test('the prepare hook runs on the staged directory before it is sealed', async () => {
    let staged = ''
    const { dir } = await materialize(release('v1'), async (path) => {
      staged = path
      cpSync(overlay, join(path, 'skills'), { recursive: true, force: true })
      writeFileSync(join(path, 'bun.lock'), 'lock\n')
    })
    expect(staged).toMatch(/\.tmp$/)
    expect(staged.startsWith(`${dir}.`)).toBe(true)
    expect(existsSync(staged)).toBe(false)
    expect(readFileSync(join(dir, 'skills/kortix-cli/SKILL.md'), 'utf8')).toBe('OVERLAY\n')
  })

  test('a failing prepare leaves no release and no staging directory', async () => {
    const built = release('v1')
    await expect(materialize(built, async () => { throw new Error('deps failed') })).rejects.toThrow(/deps failed/)
    expect(existsSync(releaseDir(store, built.descriptor.release_id!))).toBe(false)
    expect(spawnSync('ls', [store]).stdout.toString().trim()).toBe('')
  })

  test('a tracked symlink is extracted as a link to its committed target', async () => {
    symlinkSync('kortix.md', join(repo, `${REL}/agents/alias.md`))
    const built = release('symlink')
    const { dir } = await materialize(built)
    expect(readlinkSync(join(dir, 'agents/alias.md'))).toBe('kortix.md')
    expect(await verify(built, dir)).toBe(true)
  })
})

describe('extractConfigArchive refuses an archive that does not match its descriptor', () => {
  test('a changed byte', async () => {
    const built = release('v1')
    const files = structuredClone(built.descriptor.files!)
    const agent = files.find(([path]) => path === 'agents/kortix.md')!
    agent[2] = 'f'.repeat(40)
    await expect(extractConfigArchive(built.archive, files, join(root, 'x'))).rejects.toThrow(/does not match its blob ID/)
    expect(existsSync(join(root, 'x'))).toBe(false)
  })

  test('a file the descriptor does not list', async () => {
    const built = release('v1')
    const files = built.descriptor.files!.filter(([path]) => path !== 'opencode.jsonc')
    await expect(extractConfigArchive(built.archive, files, join(root, 'x'))).rejects.toThrow(/unlisted files: opencode.jsonc/)
  })

  test('a listed file the archive lacks', async () => {
    const built = release('v1')
    const files = [...built.descriptor.files!, ['agents/extra.md', '100644', 'e'.repeat(40)] as const] as never
    await expect(extractConfigArchive(built.archive, files, join(root, 'x'))).rejects.toThrow(/missing agents\/extra.md/)
  })

  test('an archive from another tree, and bytes that are not gzip', async () => {
    const first = release('v1')
    write(repo, `${REL}/agents/kortix.md`, 'PROMPT v2\n')
    const second = release('v2')
    await expect(extractConfigArchive(second.archive, first.descriptor.files!, join(root, 'x'))).rejects.toThrow(/blob ID/)
    await expect(extractConfigArchive(Buffer.from('not gzip'), first.descriptor.files!, join(root, 'x'))).rejects.toThrow(/decompress/)
  })

  test('a file list with a path inside a listed file', async () => {
    const built = release('v1')
    const files = [...built.descriptor.files!, ['opencode.jsonc/x', '100644', 'e'.repeat(40)]] as never
    await expect(extractConfigArchive(built.archive, files, join(root, 'x'))).rejects.toThrow(/inside a listed file/)
  })
})

describe('verifyRelease', () => {
  test('a tampered, a deleted, or an ADDED project file fails verification', async () => {
    const built = release('v1')
    const { dir } = await materialize(built)
    spawnSync('chmod', ['-R', 'u+w', dir])
    writeFileSync(join(dir, 'agents/kortix.md'), 'TAMPERED\n')
    expect(await verify(built, dir)).toBe(false)
    writeFileSync(join(dir, 'agents/kortix.md'), 'PROMPT v1\n')
    expect(await verify(built, dir)).toBe(true)
    writeFileSync(join(dir, 'agents/rogue.md'), 'ADDED\n')
    expect(await verify(built, dir)).toBe(false)
    rmSync(join(dir, 'agents/rogue.md'))
    rmSync(join(dir, 'skills/pdf/SKILL.md'))
    expect(await verify(built, dir)).toBe(false)
  })

  test('what the platform writes is not tampering', async () => {
    const built = release('v1')
    const { dir } = await materialize(built)
    // The platform writes these on the STAGED directory, before the seal, so
    // the test opens the root the same way `materializeRelease` has it open
    // at that point. Post-seal an agent cannot create them at all — that is
    // the case above. What is asserted here is what `verifyRelease` TOLERATES.
    spawnSync('chmod', ['u+w', dir])
    writeFileSync(join(dir, 'package.json'), '{"dependencies":{"@opencode-ai/plugin":"1.18.23"}}\n')
    writeFileSync(join(dir, 'bun.lock'), 'lock\n')
    mkdirSync(join(dir, 'node_modules/zod'), { recursive: true })
    writeFileSync(join(dir, 'node_modules/zod/index.js'), '')
    spawnSync('chmod', ['-R', 'u+w', join(dir, 'skills')])
    writeFileSync(join(dir, 'skills/kortix-cli/SKILL.md'), 'NEWER OVERLAY\n')
    expect(await verify(built, dir)).toBe(true)
  })

  /**
   * Verified on a real Daytona box (2026-09-24, release 7a60e568, session
   * 1a685caf): the seal left the release ROOT and `skills/` at 0755, so an
   * agent's `write` tool answered "Wrote file successfully." for
   * `<release>/skills/<name>/SKILL.md` and for a root-level file. The next
   * convergence then failed verification, rebuilt the release and respawned
   * OpenCode. The user saw a success message, the file vanished, and the
   * runtime restarted with no notification. Reproduced 4 times.
   *
   * A write that will be reverted must FAIL where it happens.
   */
  test('a sealed release refuses a NEW file in its root or in skills/', async () => {
    const built = release('v1');
    const { dir } = await materialize(built);
    for (const target of ['rogue.md', 'skills/rogue/SKILL.md']) {
      expect(() => {
        mkdirSync(dirname(join(dir, target)), { recursive: true });
        writeFileSync(join(dir, target), 'ADDED\n');
      }).toThrow(/EACCES|EPERM|EROFS/);
      expect(existsSync(join(dir, target))).toBe(false);
    }
    // And the release still verifies, because nothing got in.
    expect(await verify(built, dir)).toBe(true);
  });

  test('the managed-skill overlay still injects into a sealed release', async () => {
    // The one legitimate runtime writer. It unseals what it needs and puts the
    // seal back, so the hole above does not reopen for everyone else.
    const built = release('v1');
    const { dir } = await materialize(built);
    const baked = join(root, 'baked-overlay');
    mkdirSync(join(baked, 'kortix-new'), { recursive: true });
    writeFileSync(join(baked, 'kortix-new/SKILL.md'), 'NEW OVERLAY\n');

    await ensureInjectedManagedSkills(dir, { bakedDir: baked, unsealManaged: true });

    expect(readFileSync(join(dir, 'skills/kortix-new/SKILL.md'), 'utf8')).toBe('NEW OVERLAY\n');
    expect(() => writeFileSync(join(dir, 'rogue-after-inject.md'), 'x')).toThrow(/EACCES|EPERM|EROFS/);
  });

  test('a swapped symlink is compared by its target, never followed', async () => {
    symlinkSync('kortix.md', join(repo, `${REL}/agents/alias.md`))
    const built = release('symlink')
    const { dir } = await materialize(built)
    spawnSync('chmod', ['u+w', join(dir, 'agents')])
    rmSync(join(dir, 'agents/alias.md'))
    symlinkSync('/etc/passwd', join(dir, 'agents/alias.md'))
    expect(await verify(built, dir)).toBe(false)
  })
})

describe('the pointer', () => {
  test('names the release, its commit and whether it was proven', async () => {
    const built = release('v1')
    const { dir } = await materialize(built)
    expect(await readBootConfigPointer(store)).toBeNull()
    const pointer = {
      release_id: built.descriptor.release_id!,
      source_commit: built.descriptor.source_commit!,
      config_dir: REL,
      dir,
      proven: true,
    }
    await activateBootConfig(store, pointer)
    expect(await readBootConfigPointer(store)).toEqual(pointer)
    await deactivateBootConfig(store)
    expect(await readBootConfigPointer(store)).toBeNull()
  })

  test('a pointer outside the store, at another release, or in the old format is ignored', async () => {
    mkdirSync(store, { recursive: true })
    const id = 'a'.repeat(64)
    const base = { release_id: id, source_commit: 'b'.repeat(40), config_dir: REL, proven: true }
    for (const pointer of [
      { ...base, dir: '/etc' },
      { ...base, dir: join(store, 'c'.repeat(64)) },
      { ...base, dir: join(store, '..', id) },
      { ...base, release_id: 'not-hex', dir: join(store, 'not-hex') },
      { ...base, config_dir: ':(top)*', dir: join(store, id) },
      { sha: 'b'.repeat(40), relConfigDir: REL, dir: join(store, 'b'.repeat(40)) },
    ]) {
      writeFileSync(join(store, 'current.json'), JSON.stringify(pointer))
      expect(await readBootConfigPointer(store)).toBeNull()
    }
    writeFileSync(join(store, 'current.json'), '{not json')
    expect(await readBootConfigPointer(store)).toBeNull()
  })
})

describe('quarantine and pruning', () => {
  test('a quarantined release is recorded by release_id; another release_id is not blocked', async () => {
    const bad = 'd'.repeat(64)
    await quarantineRelease(store, bad, 'the new opencode did not start')
    const entries = await readQuarantine(store)
    expect(Object.keys(entries)).toEqual([bad])
    expect(entries[bad]!.reason).toBe('the new opencode did not start')
    expect(entries['e'.repeat(64)]).toBeUndefined()
  })

  test('pruning keeps the named releases with their manifests, the pointer and the quarantine', async () => {
    const first = await materialize(release('v1'))
    write(repo, `${REL}/agents/kortix.md`, 'PROMPT v2\n')
    const secondBuilt = release('v2')
    const second = await materialize(secondBuilt)
    write(repo, `${REL}/agents/kortix.md`, 'PROMPT v3\n')
    const thirdBuilt = release('v3')
    const third = await materialize(thirdBuilt)
    mkdirSync(join(store, 'f'.repeat(40)), { recursive: true }) // a copy from the git-based store
    await activateBootConfig(store, {
      release_id: thirdBuilt.descriptor.release_id!,
      source_commit: thirdBuilt.descriptor.source_commit!,
      config_dir: REL,
      dir: third.dir,
      proven: true,
    })
    await quarantineRelease(store, 'd'.repeat(64), 'x')

    await pruneBootConfigs(store, [secondBuilt.descriptor.release_id!, thirdBuilt.descriptor.release_id!])

    expect(existsSync(first.dir)).toBe(false)
    expect(existsSync(`${first.dir}.json`)).toBe(false)
    expect(existsSync(join(store, 'f'.repeat(40)))).toBe(false)
    expect(existsSync(second.dir)).toBe(true)
    expect(await readReleaseManifest(store, secondBuilt.descriptor.release_id!)).not.toBeNull()
    expect(existsSync(third.dir)).toBe(true)
    expect(await readBootConfigPointer(store)).not.toBeNull()
    expect(Object.keys(await readQuarantine(store))).toEqual(['d'.repeat(64)])
  })
})

/**
 * The boot link: OpenCode spawns at once with OPENCODE_CONFIG_DIR = this fixed
 * path, and it is repointed to the chosen config before the workspace gate
 * opens. OpenCode reads the directory at Instance init, on the first
 * directory-scoped request (verified on real OpenCode 1.18.31: a repointed
 * link was honoured).
 */
describe('the boot link', () => {
  test('is repointed atomically and survives pruning', async () => {
    const first = await materialize(release('v1'))
    const second = join(root, 'workspace-config')
    mkdirSync(second, { recursive: true })
    const link = await pointBootLink(first.dir, store)
    expect(link).toBe(bootLinkPath(store))
    expect(readlinkSync(link)).toBe(first.dir)
    expect(readFileSync(join(link, 'agents/kortix.md'), 'utf8')).toBe('PROMPT v1\n')
    await pointBootLink(second, store)
    expect(readlinkSync(link)).toBe(second)
    expect(spawnSync('ls', [store]).stdout.toString().split('\n').filter((name) => name.includes('.tmp'))).toEqual([])
    await pruneBootConfigs(store, [])
    expect(readlinkSync(link)).toBe(second)
  })
})
