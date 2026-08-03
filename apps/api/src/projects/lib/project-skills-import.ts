import { randomBytes } from 'node:crypto';
import { posix } from 'node:path';
import { SLUG_RE } from '@kortix/manifest-schema';
import JSZip, { type JSZipObject } from 'jszip';
import { parse as parseYaml } from 'yaml';
import type { ProjectConfigSummary } from '../git/types';

const AGENT_SKILL_ARCHIVE_MAX_BYTES = 10 * 1024 * 1024;
const AGENT_SKILL_EXPANDED_MAX_BYTES = 20 * 1024 * 1024;
const AGENT_SKILL_FILE_MAX_BYTES = 2 * 1024 * 1024;
const AGENT_SKILL_FILE_MAX_COUNT = 100;

export class AgentSkillImportError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AgentSkillImportError';
  }
}

export interface ImportProjectSkillInput {
  fileName: string;
  dataBase64: string;
}

export interface NormalizedProjectSkillImport {
  skills: NormalizedProjectSkill[];
  paths: string[];
}

export type ProjectSkillFileMode = '100644' | '100755';

export interface NormalizedProjectSkillFile {
  path: string;
  content: Uint8Array;
  mode: ProjectSkillFileMode;
}

export interface NormalizedProjectSkill {
  slug: string;
  name: string;
  description: string;
  files: NormalizedProjectSkillFile[];
}

export interface ProjectSkillImportFileSummary {
  path: string;
  size: number;
}

export interface ProjectSkillImportSummary {
  slug: string;
  name: string;
  description: string;
  files: ProjectSkillImportFileSummary[];
}

export function summarizeProjectSkillImport(
  skills: NormalizedProjectSkill[],
): ProjectSkillImportSummary[] {
  return skills.map((skill) => ({
    slug: skill.slug,
    name: skill.name,
    description: skill.description,
    files: skill.files.map((file) => ({
      path: file.path,
      size: file.content.byteLength,
    })),
  }));
}

export interface ProjectSkillImportTarget {
  type: 'project_repo';
  repo_url: string;
  repo_name: string | null;
  managed: boolean;
  base_branch: string;
  branch: string;
  path_prefix: '.kortix/opencode/skills';
}

export function projectSkillImportTarget(
  row: { repoUrl: string; defaultBranch: string; metadata: unknown },
  branch: string,
): ProjectSkillImportTarget {
  const metadata =
    row.metadata && typeof row.metadata === 'object'
      ? (row.metadata as Record<string, unknown>)
      : {};
  const git =
    metadata.git && typeof metadata.git === 'object'
      ? (metadata.git as Record<string, unknown>)
      : {};
  return {
    type: 'project_repo',
    repo_url: row.repoUrl,
    repo_name: typeof git.name === 'string' ? git.name : null,
    managed: git.managed === true,
    base_branch: row.defaultBranch,
    branch,
    path_prefix: '.kortix/opencode/skills',
  };
}

export function projectSkillImportBranchName(skills: NormalizedProjectSkill[]): string {
  const first = skills[0]?.slug ?? 'skill';
  const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
  return `kortix/skills/import/${first}-${stamp}-${randomBytes(4).toString('hex')}`;
}

function decodeBase64(dataBase64: string): Buffer {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(dataBase64) || dataBase64.length % 4 === 1) {
    throw new AgentSkillImportError('skill_import_invalid_base64', 'Skill upload data is invalid.');
  }
  return Buffer.from(dataBase64, 'base64');
}

function isMarkdownFile(fileName: string): boolean {
  return /(^SKILL\.md$|\.md$)/i.test(fileName);
}

function isArchiveFile(fileName: string): boolean {
  return /\.(skill|zip)$/i.test(fileName);
}

function safeArchivePath(value: string): string {
  if (
    !value ||
    value.includes('\0') ||
    value.includes('\\') ||
    value.startsWith('/') ||
    /^[A-Za-z]:/.test(value)
  ) {
    throw new AgentSkillImportError(
      'skill_archive_traversal',
      'Skill archive contains an unsafe path.',
    );
  }
  const normalized = posix.normalize(value.replace(/^\.\//, ''));
  if (normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) {
    throw new AgentSkillImportError(
      'skill_archive_traversal',
      'Skill archive contains path traversal.',
    );
  }
  return normalized.replace(/\/+$/, '');
}

function isSymlink(entry: JSZipObject): boolean {
  const raw = entry.unixPermissions;
  const permissions =
    typeof raw === 'number' ? raw : typeof raw === 'string' ? Number.parseInt(raw, 8) : 0;
  return (permissions & 0o170000) === 0o120000;
}

function fileMode(entry: JSZipObject): ProjectSkillFileMode {
  const raw = entry.unixPermissions;
  const permissions =
    typeof raw === 'number' ? raw : typeof raw === 'string' ? Number.parseInt(raw, 8) : 0;
  return (permissions & 0o111) !== 0 ? '100755' : '100644';
}

function isPlatformMetadata(path: string): boolean {
  const parts = path.split('/');
  const base = parts.at(-1) ?? '';
  return (
    parts.includes('__MACOSX') ||
    base === '.DS_Store' ||
    base.startsWith('._') ||
    base.toLowerCase() === 'thumbs.db'
  );
}

interface RawProjectSkillFile {
  path: string;
  content: Uint8Array;
  mode: ProjectSkillFileMode;
}

function decodeSkillMarkdown(file: RawProjectSkillFile): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(file.content);
  } catch {
    throw new AgentSkillImportError(
      'skill_archive_binary_file',
      `${file.path} must be UTF-8 text. Binary companion files are allowed.`,
    );
  }
}

function parseSkillFrontmatter(content: string, path: string) {
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---(?:[ \t]*\r?\n|$)/.exec(content);
  if (!match) {
    throw new AgentSkillImportError(
      'skill_frontmatter_invalid',
      `${path} must start with YAML frontmatter containing name and description.`,
    );
  }

  let value: unknown;
  try {
    value = parseYaml(match[1] ?? '');
  } catch (error) {
    throw new AgentSkillImportError(
      'skill_frontmatter_invalid',
      `${path} has invalid YAML frontmatter: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AgentSkillImportError(
      'skill_frontmatter_invalid',
      `${path} frontmatter must be an object.`,
    );
  }

  const frontmatter = value as Record<string, unknown>;
  const name = typeof frontmatter.name === 'string' ? frontmatter.name.trim() : '';
  const description =
    typeof frontmatter.description === 'string' ? frontmatter.description.trim() : '';
  if (!SLUG_RE.test(name)) {
    throw new AgentSkillImportError(
      'skill_frontmatter_invalid',
      `${path} frontmatter name must be a lowercase skill slug.`,
    );
  }
  if (!description || description.length > 4000) {
    throw new AgentSkillImportError(
      'skill_frontmatter_invalid',
      `${path} frontmatter description must contain 1 to 4000 characters.`,
    );
  }
  return { name, description };
}

function validateProjectSkillFiles(inputFiles: RawProjectSkillFile[]): NormalizedProjectSkill[] {
  if (inputFiles.length === 0 || inputFiles.length > AGENT_SKILL_FILE_MAX_COUNT) {
    throw new AgentSkillImportError(
      'skill_archive_file_count',
      `Skill archives must contain 1 to ${AGENT_SKILL_FILE_MAX_COUNT} files.`,
    );
  }

  let expandedBytes = 0;
  for (const file of inputFiles) {
    if (file.content.byteLength > AGENT_SKILL_FILE_MAX_BYTES) {
      throw new AgentSkillImportError(
        'skill_archive_file_too_large',
        `${file.path} exceeds the 2 MB per-file limit.`,
      );
    }
    expandedBytes += file.content.byteLength;
    if (expandedBytes > AGENT_SKILL_EXPANDED_MAX_BYTES) {
      throw new AgentSkillImportError(
        'skill_archive_too_large',
        'Expanded skill archive exceeds the 20 MB limit.',
      );
    }
  }

  const skillFiles = inputFiles.filter((file) => posix.basename(file.path) === 'SKILL.md');
  if (skillFiles.length === 0) {
    throw new AgentSkillImportError(
      'skill_file_missing',
      'Skill archive must contain a SKILL.md file.',
    );
  }

  const roots = skillFiles.map((file) => {
    const root = posix.dirname(file.path) === '.' ? '' : posix.dirname(file.path);
    const validated = parseSkillFrontmatter(decodeSkillMarkdown(file), file.path);
    return {
      file,
      root,
      slug: validated.name,
      name: validated.name,
      description: validated.description,
      files: [] as NormalizedProjectSkillFile[],
    };
  });

  const slugs = new Set<string>();
  for (const root of roots) {
    if (slugs.has(root.slug)) {
      throw new AgentSkillImportError(
        'skill_slug_duplicate',
        `Skill archive contains duplicate skill slug "${root.slug}".`,
      );
    }
    slugs.add(root.slug);
  }

  for (const file of inputFiles) {
    const owner = roots
      .filter(({ root }) => !root || file.path === root || file.path.startsWith(`${root}/`))
      .sort((left, right) => right.root.length - left.root.length)[0];
    if (!owner) {
      throw new AgentSkillImportError(
        'skill_archive_unowned_file',
        `${file.path} is outside every skill folder. Move it beside or below a SKILL.md file.`,
      );
    }
    const relativePath = owner.root ? file.path.slice(owner.root.length + 1) : file.path;
    owner.files.push({
      path: `.kortix/opencode/skills/${owner.slug}/${relativePath}`,
      content: file.content,
      mode: file.mode,
    });
  }

  return roots
    .map(({ slug, name, description, files }) => ({
      slug,
      name,
      description,
      files: files.sort((left, right) => {
        const leftSkill = left.path.endsWith('/SKILL.md') ? 0 : 1;
        const rightSkill = right.path.endsWith('/SKILL.md') ? 0 : 1;
        return leftSkill - rightSkill || left.path.localeCompare(right.path);
      }),
    }))
    .sort((left, right) => left.slug.localeCompare(right.slug));
}

async function readProjectSkillArchive(bytes: Uint8Array): Promise<NormalizedProjectSkill[]> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes, {
      checkCRC32: true,
      createFolders: true,
    });
  } catch (error) {
    throw new AgentSkillImportError(
      'skill_archive_invalid',
      `Skill archive is not a valid ZIP file: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const files: RawProjectSkillFile[] = [];
  let expandedBytes = 0;
  for (const entry of Object.values(zip.files)) {
    const original =
      (entry as JSZipObject & { unsafeOriginalName?: string }).unsafeOriginalName ?? entry.name;
    safeArchivePath(original);
    if (isSymlink(entry)) {
      throw new AgentSkillImportError(
        'skill_archive_symlink',
        'Skill archives cannot contain symlinks.',
      );
    }
    if (entry.dir) continue;
    const path = safeArchivePath(entry.name);
    if (isPlatformMetadata(path)) continue;
    if (files.length >= AGENT_SKILL_FILE_MAX_COUNT) {
      throw new AgentSkillImportError(
        'skill_archive_file_count',
        `Skill archives must contain 1 to ${AGENT_SKILL_FILE_MAX_COUNT} files.`,
      );
    }
    const content = await entry.async('uint8array');
    if (content.byteLength > AGENT_SKILL_FILE_MAX_BYTES) {
      throw new AgentSkillImportError(
        'skill_archive_file_too_large',
        `${path} exceeds the 2 MB per-file limit.`,
      );
    }
    expandedBytes += content.byteLength;
    if (expandedBytes > AGENT_SKILL_EXPANDED_MAX_BYTES) {
      throw new AgentSkillImportError(
        'skill_archive_too_large',
        'Expanded skill archive exceeds the 20 MB limit.',
      );
    }
    files.push({ path, content, mode: fileMode(entry) });
  }
  return validateProjectSkillFiles(files);
}

function skillSlugFromPath(path: string): string | null {
  const match = /\/skills\/(.+?)\/SKILL\.md$/.exec(path);
  return match?.[1] ?? null;
}

export async function normalizeProjectSkillImport(
  input: ImportProjectSkillInput,
): Promise<NormalizedProjectSkillImport> {
  const fileName = input.fileName.trim();
  if (!isMarkdownFile(fileName) && !isArchiveFile(fileName)) {
    throw new AgentSkillImportError(
      'skill_import_extension',
      'Choose a SKILL.md, .md, .skill, or ZIP file.',
    );
  }

  const bytes = decodeBase64(input.dataBase64);
  if (bytes.byteLength === 0 || bytes.byteLength > AGENT_SKILL_ARCHIVE_MAX_BYTES) {
    throw new AgentSkillImportError(
      'skill_archive_size',
      'Skill upload must contain 1 byte to 10 MB.',
    );
  }

  let skills: NormalizedProjectSkill[];
  if (isMarkdownFile(fileName)) {
    skills = validateProjectSkillFiles([{ path: 'SKILL.md', content: bytes, mode: '100644' }]);
  } else {
    skills = await readProjectSkillArchive(bytes);
  }

  return {
    skills,
    paths: skills.flatMap((skill) => skill.files.map((file) => file.path)),
  };
}

export function assertProjectSkillSlugsAvailable(
  skills: NormalizedProjectSkill[],
  existingSkills: ProjectConfigSummary['skills'],
): void {
  const existingSlugs = new Set(
    (existingSkills ?? []).map((skill) => skillSlugFromPath(skill.path) ?? skill.name),
  );
  const duplicate = skills.find((skill) => existingSlugs.has(skill.slug));
  if (duplicate) {
    throw new AgentSkillImportError(
      'project_skill_slug_duplicate',
      `Project already has a skill with slug "${duplicate.slug}".`,
    );
  }
}
