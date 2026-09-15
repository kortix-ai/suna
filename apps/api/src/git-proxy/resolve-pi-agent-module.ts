import {
  manifestCandidatePaths,
  manifestFormatForPath,
  parseManifestText,
  validAgentResourceSource,
  type AgentBlockV2,
} from '@kortix/manifest-schema';
import { readManifestFromRepo, type GitBackedProject } from '../projects/git';
import { parseAgentMarkdown } from '../projects/lib/agent-markdown';
import {
  compilePiAgentModule,
  resolvePiConfigDir,
  validatePiAgentFrontmatter,
} from './pi-agent-module';
import { preparePiDependencies } from './pi-agent-dependencies';
import { refreshMirror, runGit } from '../projects/git/mirror';

export async function resolvePiAgentModule(
  project: GitBackedProject,
  sourceSha: string,
  agentName: string,
) {
  const found = await readManifestFromRepo(
    project,
    manifestCandidatePaths(project.manifestPath).map((p) => p.path),
    sourceSha,
  );
  if (!found) throw new Error('Pi agent module requires a manifest at the compiled Git SHA');
  const manifest = parseManifestText(found.content, manifestFormatForPath(found.path));
  const configDir = resolvePiConfigDir(manifest);
  const explicit = (manifest.agents as Record<string, AgentBlockV2> | undefined)?.[agentName]
    ?.config;
  if (explicit !== undefined) {
    const { prompt, pi, ...behavior } = explicit;
    validatePiAgentFrontmatter(behavior, agentName);
    if (!pi) return null;
    if (!validAgentResourceSource(pi.source) || !/\.(ts|js|mjs)$/.test(pi.source))
      throw new Error(`Pi agent "${agentName}" has an invalid source`);
  }
  const mirror = await refreshMirror(project);
  const tree = await runGit(
    ['ls-tree', '-r', '-z', '-l', sourceSha, '--', ...(explicit ? [] : [configDir])],
    mirror,
    false,
  );
  const blobs = new Map<string, { sha: string; size: number }>();
  for (const entry of tree.stdout.split('\0')) {
    const match = /^(100644|100755) blob ([a-f0-9]{40})\s+(\d+)\t(.+)$/.exec(entry);
    if (match) blobs.set(match[4]!, { sha: match[2]!, size: Number(match[3]) });
  }
  const paths = new Set(blobs.keys());
  const read = async (path: string) => {
    const blob = blobs.get(path);
    if (!blob || !validAgentResourceSource(path))
      throw new Error(
        `Pi agent source "${path}" must be an existing regular Git file without secrets or traversal`,
      );
    if (blob.size > 8 * 1024 * 1024) throw new Error(`Pi agent source "${path}" exceeds 8 MiB`);
    return (await runGit(['cat-file', 'blob', blob.sha], mirror, false)).stdout;
  };
  const markdown = `${configDir}/agents/${agentName}.md`;
  if (explicit === undefined && paths.has(markdown))
    validatePiAgentFrontmatter(parseAgentMarkdown(await read(markdown)).frontmatter, agentName);
  const entries = explicit?.pi
    ? [explicit.pi.source]
    : ['ts', 'js', 'mjs']
        .map((extension) => `${configDir}/agents/${agentName}.${extension}`)
        .filter((path) => paths.has(path));
  if (entries.length > 1)
    throw new Error(`Pi agent "${agentName}" has multiple source entrypoints`);
  if (!entries.length) return null;
  const sourcePaths = [...paths].filter(
    (path) =>
      /\.(ts|tsx|js|jsx|mjs|cjs|json|md|txt)$/.test(path) &&
      path !== configDir + '/package-lock.json' &&
      path !== configDir + '/package.json',
  );
  const packageJson = paths.has(configDir + '/package.json')
    ? await read(configDir + '/package.json')
    : undefined;
  const packageLock = paths.has(configDir + '/package-lock.json')
    ? await read(configDir + '/package-lock.json')
    : undefined;
  if (Boolean(packageJson) !== Boolean(packageLock))
    throw new Error(
      'Pi npm dependencies require both package.json and package-lock.json in the config directory',
    );
  const dependencies =
    packageJson && packageLock
      ? await preparePiDependencies({ packageJson, packageLock })
      : undefined;
  try {
    const result = await compilePiAgentModule({
      entry: entries[0]!,
      files: {},
      sourcePaths: new Set(sourcePaths),
      loadSource: read,
      dependencyRoot: dependencies?.root,
      dependencyLockSha256: dependencies?.lockSha256,
    });
    return { ...result, entry: entries[0]! };
  } finally {
    await dependencies?.cleanup();
  }
}
