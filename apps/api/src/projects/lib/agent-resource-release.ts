import { manifestCandidatePaths, manifestFormatForPath, parseManifestText } from '@kortix/manifest-schema';
import { readManifestFromRepo, type GitBackedProject } from '../git';

export function agentResourceSourceSha(metadata: unknown): string | undefined {
  const value = (metadata as Record<string, unknown> | null)?.agent_resources_sha;
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || !/^[a-f0-9]{40}$/.test(value))
    throw new Error('Agent resource source identity is invalid');
  return value;
}

export async function resolveOpenCodeResourceSourceSha(
  project: GitBackedProject,
  sha: string,
  agentName: string,
): Promise<string | undefined> {
  const found = await readManifestFromRepo(project, manifestCandidatePaths(project.manifestPath).map(p => p.path), sha);
  if (!found) return undefined;
  const manifest = parseManifestText(found.content, manifestFormatForPath(found.path));
  const agent = (manifest.agents as Record<string, { resources?: { environment?: unknown[] } }> | undefined)?.[agentName];
  return Number(manifest.kortix_version) === 2 && agent?.resources?.environment?.length
    ? agentResourceSourceSha({ agent_resources_sha: sha })
    : undefined;
}
