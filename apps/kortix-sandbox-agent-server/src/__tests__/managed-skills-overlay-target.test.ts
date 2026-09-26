/**
 * The managed-skill overlay goes where OpenCode reads its config, and never
 * into /workspace when OpenCode does not read it from there.
 *
 * Verification 2026-09-22 (DEF-6): a fresh session on a main with a broken
 * opencode.jsonc fell back to the image default config. The runtime-assets
 * pass then asked `resolveConfigDir` where the overlay goes. There was no
 * running release, so it answered the working tree, and the overlay rewrote the
 * tracked `.kortix/opencode/skills/kortix-cli/SKILL.md` in /workspace:
 * `git status` showed ` M .kortix/opencode/skills/kortix-cli/SKILL.md` on a
 * session nobody had touched. OpenCode did not even read that directory.
 */
import { afterAll, afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Config } from '../config'
import { createOpenCodeAssetsService } from '../harness/open-code/assets'
import { resetConfigReleaseStateForTests } from '../harness/open-code/config-release'
import { restoreTestConfigRoot, serveTestConfigDir } from './helpers/boot-link'

const roots: string[] = []

async function fixture(): Promise<{ cfg: Config; workspaceConfigDir: string; imageDefaultDir: string }> {
  const root = await mkdtemp(join(tmpdir(), 'overlay-target-'))
  roots.push(root)
  const workspace = join(root, 'workspace')
  const workspaceConfigDir = join(workspace, '.kortix', 'opencode')
  const imageDefaultDir = join(root, 'image-default')
  await mkdir(workspaceConfigDir, { recursive: true })
  await mkdir(imageDefaultDir, { recursive: true })
  await writeFile(join(workspaceConfigDir, 'opencode.jsonc'), '{ "broken": }\n')
  const cfg = {
    projectTarget: workspace,
    workspace,
    opencodeInternalPort: 4096,
    opencodeStandbyPort: 4097,
    defaultOpencodeConfigDir: imageDefaultDir,
  } as unknown as Config
  return { cfg, workspaceConfigDir, imageDefaultDir }
}

// `serveTestConfigDir` redirects KORTIX_BOOT_CONFIG_ROOT at a throwaway
// directory. Put it back: the override belongs to this file, and every later
// reader of `bootConfigRoot()` must see the real default again.
afterAll(restoreTestConfigRoot)

afterEach(async () => {
  resetConfigReleaseStateForTests()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('managed-skill overlay target', () => {
  // The overlay goes where OpenCode READS, and that is the boot link's target.
  // Re-deriving it from the running report and the working tree is how an
  // overlay once rewrote tracked managed skills in `/workspace` (DEF-6).
  test('a box that fell back to the image default overlays the image default dir, not /workspace', async () => {
    const { cfg, imageDefaultDir } = await fixture()
    roots.push(await serveTestConfigDir(imageDefaultDir))
    const assets = createOpenCodeAssetsService()
    expect(await assets.resolveConfigDir(cfg)).toBe(imageDefaultDir)
  })

  test('the overlay follows the boot link, whatever the running report says', async () => {
    const { cfg, workspaceConfigDir } = await fixture()
    roots.push(await serveTestConfigDir(workspaceConfigDir))
    const assets = createOpenCodeAssetsService()
    expect(await assets.resolveConfigDir(cfg)).toBe(workspaceConfigDir)
  })

  test('no boot link at all: the image default, never the working tree', async () => {
    const { cfg, imageDefaultDir } = await fixture()
    roots.push(await serveTestConfigDir(join(imageDefaultDir, 'does-not-exist')))
    const assets = createOpenCodeAssetsService()
    expect(await assets.resolveConfigDir(cfg)).toBe(imageDefaultDir)
  })
})

describe('managed-skill overlay target on the root layout', () => {
  test('a working-tree config dir without skills/ hands the overlay to the project root skills/', async () => {
    const root = await mkdtemp(join(tmpdir(), 'overlay-root-layout-'))
    roots.push(root)
    const workspace = join(root, 'workspace')
    const configDir = join(workspace, 'harnesses', 'opencode')
    await mkdir(configDir, { recursive: true })
    await mkdir(join(workspace, 'skills', 'kortix-cli'), { recursive: true })
    const { managedOverlayRoot } = await import('../project-layout')
    expect(managedOverlayRoot(configDir, workspace)).toBe(workspace)
    // The legacy dir keeps its own skills/.
    const legacy = join(workspace, '.kortix', 'opencode')
    await mkdir(join(legacy, 'skills'), { recursive: true })
    expect(managedOverlayRoot(legacy, workspace)).toBe(legacy)
    // A project that keeps no skills anywhere: the overlay stays with the config dir.
    const bare = join(root, 'bare')
    await mkdir(join(bare, 'harnesses', 'opencode'), { recursive: true })
    expect(managedOverlayRoot(join(bare, 'harnesses', 'opencode'), bare)).toBe(join(bare, 'harnesses', 'opencode'))
    // A dir outside the working tree (a release, the image default) is never redirected.
    expect(managedOverlayRoot(join(root, 'release'), workspace)).toBe(join(root, 'release'))
  })

  test('the assets service answers the project root for a served root-layout config dir', async () => {
    const root = await mkdtemp(join(tmpdir(), 'overlay-root-served-'))
    roots.push(root)
    const workspace = join(root, 'workspace')
    const configDir = join(workspace, 'harnesses', 'opencode')
    await mkdir(configDir, { recursive: true })
    await mkdir(join(workspace, 'skills'), { recursive: true })
    await writeFile(join(configDir, 'opencode.jsonc'), '{}\n')
    roots.push(await serveTestConfigDir(configDir))
    const cfg = {
      projectTarget: workspace,
      workspace,
      opencodeInternalPort: 4096,
      opencodeStandbyPort: 4097,
      defaultOpencodeConfigDir: join(root, 'image-default'),
    } as unknown as Config
    const assets = createOpenCodeAssetsService()
    expect(await assets.resolveConfigDir(cfg)).toBe(workspace)
  })
})
