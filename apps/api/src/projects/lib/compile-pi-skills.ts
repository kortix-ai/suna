/**
 * Compile project skill instructions for the immutable Pi runtime artifact.
 *
 * Only `SKILL.md` is read into the artifact. Supporting paths are recorded so
 * the model can use the environment `read`/`bash` tools for them. Their bytes
 * never enter the worker and no worker-side filesystem lookup is possible.
 */
import {
  manifestCandidatePaths,
  manifestDefaultConfigDir,
  manifestFormatForPath,
  parseManifestText,
} from '@kortix/manifest-schema';
import { type GitBackedProject, listRepoFiles, readManifestFromRepo, readRepoFile } from '../git';
import { parseAgentMarkdown } from './agent-markdown';

export interface CompiledPiSkill {
  /** Permission and tool lookup key. OpenCode derives this from `name`. */
  name: string;
  description?: string;
  /** Repository-relative source path at the compiled SHA. */
  location: string;
  /** Markdown body with YAML frontmatter removed. */
  content: string;
  /** At most ten repository-relative paths below the skill directory. */
  files: string[];
}

interface CompilePiSkillsInput {
  configDir: string;
  /** Keys are the exact Git-tree paths. Only SKILL.md values are inspected. */
  files: Record<string, string | undefined>;
}

type PermissionAction = 'allow' | 'ask' | 'deny';
type PermissionRule = PermissionAction | Record<string, PermissionAction>;
export type PiSkillPermissionConfig = PermissionAction | Record<string, PermissionRule | undefined>;

const COMPATIBILITY_SKILL_ROOTS = [
  '.claude/skills',
  '.agents/skills',
  '.opencode/skills',
  '.kortix/opencode/skills',
  '.kortix/pi/skills',
] as const;

function manifestSchemaVersion(manifest: Record<string, unknown>): number {
  const value = manifest.kortix_version;
  if (typeof value === 'number' && Number.isFinite(value)) return Math.floor(value);
  if (typeof value === 'string' && Number.isFinite(Number(value))) return Math.floor(Number(value));
  return 1;
}

function configDirOf(block: unknown): string | null {
  if (!block || typeof block !== 'object' || Array.isArray(block)) return null;
  const value = (block as Record<string, unknown>).config_dir;
  if (typeof value !== 'string' || !value.trim()) return null;
  const normalized = value.trim().replace(/\/+$/, '');
  if (normalized.startsWith('/') || normalized.split('/').includes('..')) {
    throw new Error(`invalid Pi skill config_dir: ${value}`);
  }
  return normalized;
}

function skillConfigDir(manifest: Record<string, unknown>): string {
  return (
    configDirOf(manifest.pi) ??
    configDirOf(manifest.opencode) ??
    manifestDefaultConfigDir(manifestSchemaVersion(manifest))
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function skillRoots(configDir: string): string[] {
  // Sources are ordered from low to high precedence. Kortix's configured
  // project directory wins over compatibility mirrors with the same name.
  const configured = `${configDir}/skills`;
  return [...COMPATIBILITY_SKILL_ROOTS.filter((root) => root !== configured), configured];
}

function descriptionAt(path: string, value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new Error(`Pi skill at "${path}" field "description" must be a string`);
  }
  return value;
}

function compileOneSkill(
  location: string,
  raw: string,
  allPaths: readonly string[],
): CompiledPiSkill {
  const parsed = parseAgentMarkdown(raw);
  const name = parsed.frontmatter.name;
  if (typeof name !== 'string' || !name.trim()) {
    throw new Error(`Pi skill at "${location}" requires a non-empty frontmatter name`);
  }
  const base = location.slice(0, -'/SKILL.md'.length);
  const files = allPaths
    .filter(
      (path) => path.startsWith(`${base}/`) && path !== location && !path.endsWith('/SKILL.md'),
    )
    .map((path) => path.slice(base.length + 1))
    .sort()
    .slice(0, 10);
  const description = descriptionAt(location, parsed.frontmatter.description);
  return {
    name: name.trim(),
    ...(description !== undefined ? { description } : {}),
    location,
    content: parsed.body,
    files,
  };
}

export function compilePiSkills(input: CompilePiSkillsInput): CompiledPiSkill[] {
  const paths = Object.keys(input.files).sort();
  const skills = new Map<string, CompiledPiSkill>();
  for (const root of skillRoots(input.configDir)) {
    const pattern = new RegExp(`^${escapeRegExp(root)}/(?:.+/)?SKILL\\.md$`);
    for (const location of paths.filter((path) => pattern.test(path))) {
      const raw = input.files[location];
      if (raw === undefined) throw new Error(`Pi skill path "${location}" has no content`);
      const skill = compileOneSkill(location, raw, paths);
      skills.set(skill.name, skill);
    }
  }
  return [...skills.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function wildcardMatch(value: string, pattern: string): boolean {
  let source = '^';
  for (const character of pattern) {
    if (character === '*') source += '.*';
    else if (character === '?') source += '.';
    else source += character.replace(/[\\^$+?.()|{}[\]]/g, '\\$&');
  }
  return new RegExp(`${source}$`, 'u').test(value);
}

function skillPermissionAction(config: PiSkillPermissionConfig | undefined, name: string) {
  if (config === undefined) return 'allow' as const;
  if (typeof config === 'string') return config;
  let result: PermissionAction = 'allow';
  for (const [permission, rule] of Object.entries(config)) {
    if (!rule || !wildcardMatch('skill', permission)) continue;
    if (typeof rule === 'string') {
      result = rule;
      continue;
    }
    for (const [pattern, action] of Object.entries(rule)) {
      if (wildcardMatch(name, pattern)) result = action;
    }
  }
  return result;
}

/** Remove statically denied bodies before bytes enter the per-agent artifact. */
export function filterPiSkillsForPermission(
  skills: readonly CompiledPiSkill[],
  permission: PiSkillPermissionConfig | undefined,
): CompiledPiSkill[] {
  return skills.filter((skill) => skillPermissionAction(permission, skill.name) !== 'deny');
}

export async function resolveCompiledPiSkillsForSession(
  project: GitBackedProject,
  sourceSha: string,
): Promise<CompiledPiSkill[]> {
  const manifest = await readManifestFromRepo(
    project,
    manifestCandidatePaths(project.manifestPath).map((candidate) => candidate.path),
    sourceSha,
  );
  const parsedManifest = manifest
    ? (parseManifestText(manifest.content, manifestFormatForPath(manifest.path)) as Record<
        string,
        unknown
      >)
    : {};
  const configDir = skillConfigDir(parsedManifest);
  const repoPaths = (await listRepoFiles(project, sourceSha)).map((file) => file.path).sort();
  const rootPatterns = skillRoots(configDir).map(
    (root) => new RegExp(`^${escapeRegExp(root)}/(?:.+/)?SKILL\\.md$`),
  );
  const skillPaths = repoPaths.filter((path) => rootPatterns.some((pattern) => pattern.test(path)));
  const files: Record<string, string | undefined> = Object.fromEntries(
    repoPaths.map((path) => [path, undefined]),
  );
  await Promise.all(
    skillPaths.map(async (path) => {
      files[path] = await readRepoFile(project, path, sourceSha);
    }),
  );
  return compilePiSkills({ configDir, files });
}
