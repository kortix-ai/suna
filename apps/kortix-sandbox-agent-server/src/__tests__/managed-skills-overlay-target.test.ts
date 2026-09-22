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
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Config } from '../config'
import { createOpenCodeAssetsService } from '../harness/open-code/assets'
import { recordBootConfig, resetConfigReleaseStateForTests } from '../harness/open-code/config-release'

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

afterEach(async () => {
  resetConfigReleaseStateForTests()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('managed-skill overlay target', () => {
  test('a box that fell back to the image default overlays the image default dir, not /workspace', async () => {
    const { cfg, imageDefaultDir } = await fixture()
    recordBootConfig({ source: 'image-default', release_id: null })
    const assets = createOpenCodeAssetsService()
    expect(await assets.resolveConfigDir(cfg)).toBe(imageDefaultDir)
  })

  test('a box that runs its workspace config still overlays the workspace config dir', async () => {
    const { cfg, workspaceConfigDir } = await fixture()
    recordBootConfig({ source: 'workspace', release_id: null })
    const assets = createOpenCodeAssetsService()
    expect(await assets.resolveConfigDir(cfg)).toBe(workspaceConfigDir)
  })
})
