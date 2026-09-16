import { validAgentResourceSource } from './agent-resources';
import { manifestDefaultConfigDir } from './constants';

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export function manifestConfigDir(manifest: Record<string, unknown>): string {
  if (manifest.config_dir !== undefined) {
    if (!validAgentResourceSource(manifest.config_dir))
      throw new Error(
        'config_dir must be a repository-relative directory without secrets or traversal',
      );
    return manifest.config_dir;
  }
  for (const block of [manifest.pi, manifest.opencode]) {
    if (record(block) && typeof block.config_dir === 'string') {
      const directory = block.config_dir.trim();
      if (!directory) continue;
      let end = directory.length;
      while (end > 0 && directory[end - 1] === '/') end -= 1;
      return directory.slice(0, end);
    }
  }
  return manifestDefaultConfigDir(Number(manifest.kortix_version));
}
