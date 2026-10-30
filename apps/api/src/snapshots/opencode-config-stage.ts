import { cp } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';

function isRuntimeDependencyPath(sourceRoot: string, sourcePath: string): boolean {
  return relative(sourceRoot, sourcePath)
    .split(sep)
    .some((segment) => segment === 'node_modules' || segment.startsWith('.node_modules-backup-'));
}

/** @deprecated OpenCode only. OpenCode is sunset: no new code. See apps/kortix-sandbox-agent-server/src/harness/README.md "OpenCode sunset". */
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
