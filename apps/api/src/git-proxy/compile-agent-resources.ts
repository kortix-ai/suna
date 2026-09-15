import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  manifestCandidatePaths,
  manifestFormatForPath,
  parseManifestText,
  validateAgentResources,
  type AgentResources,
  type ManifestIssue,
} from '@kortix/manifest-schema';
import { MAX_AGENT_RESOURCE_BYTES, type CompiledAgentResource } from '@kortix/manifest-schema';
import { readManifestFromRepo, type GitBackedProject } from '../projects/git';
import { refreshMirror, runGit } from '../projects/git/mirror';

const MAX_BYTES = MAX_AGENT_RESOURCE_BYTES;
const execFileAsync = promisify(execFile);

export async function compileAgentResources(
  manifest: Record<string, unknown>,
  agentName: string,
  read: (path: string) => Promise<Uint8Array>,
): Promise<CompiledAgentResource[]> {
  const value = (manifest.agents as Record<string, { resources?: unknown }> | undefined)?.[
    agentName
  ]?.resources;
  const issues: ManifestIssue[] = [];
  validateAgentResources(value, `agents.${agentName}.resources`, issues);
  if (issues.length)
    throw new Error(issues.map((issue) => `${issue.path}: ${issue.message}`).join('; '));
  const config = (value ?? {}) as AgentResources;
  const entries = [
    ...Object.entries(config.worker ?? {}).map(([name, source]) => ({
      placement: 'worker' as const,
      name,
      source,
    })),
    ...(config.environment ?? []).map((file) => ({ placement: 'environment' as const, ...file })),
  ];
  const assets: CompiledAgentResource[] = [];
  let size = 0;
  for (const entry of entries) {
    const bytes = Buffer.from(await read(entry.source));
    size += bytes.length;
    if (size > MAX_BYTES) throw new Error(`Pi agent "${agentName}" resources exceed 8 MiB`);
    assets.push({
      ...entry,
      content: bytes.toString('base64'),
      size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
  }
  return assets;
}

export async function resolveCompiledAgentResources(
  project: GitBackedProject,
  sourceSha: string,
  agentName: string,
) {
  const found = await readManifestFromRepo(
    project,
    manifestCandidatePaths(project.manifestPath).map((path) => path.path),
    sourceSha,
  );
  if (!found) throw new Error('Agent resources require a manifest at the pinned source SHA');
  const manifest = parseManifestText(found.content, manifestFormatForPath(found.path));
  let mirror: string | undefined;
  return compileAgentResources(manifest, agentName, async (path) => {
    mirror ??= await refreshMirror(project);
    const listed = await runGit(['ls-tree', '-z', sourceSha, '--', path], mirror, false);
    const match = /^(100644|100755) blob ([a-f0-9]{40})\t([^\0]+)\0$/.exec(listed.stdout);
    if (!match || match[3] !== path)
      throw new Error(
        `Agent resource "${path}" must be an existing regular Git file; symlinks and submodules are unsupported`,
      );
    const { stdout: size } = await execFileAsync('git', ['cat-file', '-s', match[2]!], {
      cwd: mirror,
      encoding: 'utf8',
      timeout: 30000,
    });
    if (Number(size) > MAX_BYTES) throw new Error(`Agent resource "${path}" exceeds 8 MiB`);
    const { stdout } = await execFileAsync('git', ['cat-file', 'blob', match[2]!], {
      cwd: mirror,
      encoding: 'buffer',
      maxBuffer: MAX_BYTES + 1,
      timeout: 30000,
    });
    return stdout;
  });
}
