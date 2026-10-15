import { cp, rename, writeFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';

function isRuntimeDependencyPath(sourceRoot: string, sourcePath: string): boolean {
  return relative(sourceRoot, sourcePath)
    .split(sep)
    .some((segment) => segment === 'node_modules' || segment.startsWith('.node_modules-backup-'));
}

export async function stageOpencodeConfigTree(
  sourcePath: string,
  destinationPath: string,
): Promise<void> {
  const sourceRoot = resolve(sourcePath);
  await cp(sourceRoot, destinationPath, {
    recursive: true,
    filter: (currentSource) => !isRuntimeDependencyPath(sourceRoot, currentSource),
  });
}

/**
 * The OpenCode config dir the image warms against, composed from the starter's
 * pty extension: its module tree under `plugins/`, its `package.json` and
 * `bun.lock` at the root, and an `opencode.jsonc` with the starter agents'
 * permission (`allow`). A kortix_version 3 starter ships no OpenCode config dir.
 */
export async function stageStarterOpencodeConfig(
  extensionPath: string,
  destinationPath: string,
): Promise<void> {
  const plugins = join(destinationPath, 'plugins');
  await stageOpencodeConfigTree(extensionPath, plugins);
  for (const name of ['package.json', 'bun.lock']) {
    await rename(join(plugins, name), join(destinationPath, name));
  }
  await writeFile(
    join(destinationPath, 'opencode.jsonc'),
    '{ "$schema": "https://opencode.ai/config.json", "permission": "allow" }\n',
  );
}
