import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { pluginFilesFrom, toolNamesFromFiles } from './proven-check'

export async function pluginFilesInDir(dir: string): Promise<string[]> {
  const entries = await readdir(join(dir, 'plugins'), { withFileTypes: true }).catch(() => [])
  return pluginFilesFrom(entries.filter((entry) => entry.isFile()).map((entry) => `plugins/${entry.name}`))
}

export async function toolNamesInDir(dir: string): Promise<string[]> {
  const entries = await readdir(join(dir, 'tools'), { withFileTypes: true }).catch(() => [])
  return toolNamesFromFiles(entries.filter((entry) => entry.isFile()).map((entry) => `tools/${entry.name}`))
}
