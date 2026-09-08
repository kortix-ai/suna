import {
  manifestCandidatePaths,
  manifestFormatForPath,
  parseManifestText,
} from '@kortix/manifest-schema';
import {
  listRepoFiles,
  readManifestFromRepo,
  readRepoFile,
  type GitBackedProject,
} from '../projects/git';
import { parseAgentMarkdown } from '../projects/lib/agent-markdown';
import {
  compilePiAgentModule,
  resolvePiConfigDir,
  validatePiAgentFrontmatter,
} from './pi-agent-module';
import { preparePiDependencies } from './pi-agent-dependencies';

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
  const paths = new Set(
    (await listRepoFiles(project, sourceSha, configDir)).map((file) => file.path),
  );
  const markdown = `${configDir}/agents/${agentName}.md`;
  if (paths.has(markdown))
    validatePiAgentFrontmatter(
      parseAgentMarkdown(await readRepoFile(project, markdown, sourceSha)).frontmatter,
      agentName,
    );
  const entries = ['ts', 'js', 'mjs']
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
  if (sourcePaths.length > 256)
    throw new Error('Pi agent config directory exceeds 256 source files');
  const files: Record<string, string> = {};
  let bytes = 0;
  for (const path of sourcePaths) {
    const content = await readRepoFile(project, path, sourceSha);
    bytes += Buffer.byteLength(content);
    if (bytes > 8 * 1024 * 1024) throw new Error('Pi agent source exceeds 8 MiB');
    files[path.slice(configDir.length + 1)] = content;
  }
  const packageJson = paths.has(configDir + '/package.json')
    ? await readRepoFile(project, configDir + '/package.json', sourceSha)
    : undefined;
  const packageLock = paths.has(configDir + '/package-lock.json')
    ? await readRepoFile(project, configDir + '/package-lock.json', sourceSha)
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
      entry: entries[0]!.slice(configDir.length + 1),
      files,
      dependencyRoot: dependencies?.root,
      dependencyLockSha256: dependencies?.lockSha256,
    });
    return { ...result, entry: entries[0]! };
  } finally {
    await dependencies?.cleanup();
  }
}
