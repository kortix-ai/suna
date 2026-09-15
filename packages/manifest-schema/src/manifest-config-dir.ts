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
    if (record(block) && typeof block.config_dir === 'string' && block.config_dir.trim())
      return block.config_dir.trim().replace(/\/+$/, '');
  }
  return manifestDefaultConfigDir(Number(manifest.kortix_version));
}

