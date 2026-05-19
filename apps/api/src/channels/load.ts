import type { GitBackedProject } from '../projects/git';
import { MANIFEST_FILENAME, readManifest } from '../projects/triggers';
import { extractChannels, type LoadedChannels } from './manifest';

export async function loadProjectChannels(project: GitBackedProject): Promise<LoadedChannels> {
  let manifest;
  try {
    manifest = await readManifest(project);
  } catch (e) {
    return {
      specs: [],
      errors: [{
        platform: '(manifest)',
        path: MANIFEST_FILENAME,
        error: (e as Error).message || 'Failed to read manifest',
      }],
    };
  }
  if (!manifest) return { specs: [], errors: [] };
  return extractChannels(manifest);
}
