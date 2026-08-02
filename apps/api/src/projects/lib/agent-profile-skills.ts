import { posix } from 'node:path';
import { SLUG_RE } from '@kortix/manifest-schema';
import JSZip, { type JSZipObject } from 'jszip';
import { parse as parseYaml } from 'yaml';

export const AGENT_SKILL_ARCHIVE_MAX_BYTES = 10 * 1024 * 1024;
export const AGENT_SKILL_EXPANDED_MAX_BYTES = 20 * 1024 * 1024;
export const AGENT_SKILL_FILE_MAX_BYTES = 2 * 1024 * 1024;
export const AGENT_SKILL_FILE_MAX_COUNT = 100;

export interface AgentProfileSkillFile {
  path: string;
  content: string;
}

export interface ValidatedAgentSkill {
  slug: string;
  name: string;
  description: string;
  files: AgentProfileSkillFile[];
}

export class AgentSkillImportError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'AgentSkillImportError';
  }
}

function safeArchivePath(value: string): string {
  if (
    !value ||
    value.includes('\0') ||
    value.includes('\\') ||
    value.startsWith('/') ||
    /^[A-Za-z]:/.test(value)
  ) {
    throw new AgentSkillImportError('skill_archive_traversal', 'Skill archive contains an unsafe path.');
  }
  const normalized = posix.normalize(value.replace(/^\.\//, ''));
  if (normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) {
    throw new AgentSkillImportError('skill_archive_traversal', 'Skill archive contains path traversal.');
  }
  return normalized.replace(/\/+$/, '');
}

function symlink(entry: JSZipObject): boolean {
  const raw = entry.unixPermissions;
  const permissions =
    typeof raw === 'number' ? raw : typeof raw === 'string' ? Number.parseInt(raw, 8) : 0;
  return (permissions & 0o170000) === 0o120000;
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
    value = parseYaml(match[1]!);
  } catch (error) {
    throw new AgentSkillImportError(
      'skill_frontmatter_invalid',
      `${path} has invalid YAML frontmatter: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AgentSkillImportError('skill_frontmatter_invalid', `${path} frontmatter must be an object.`);
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

export function validateAgentSkillFiles(
  inputFiles: Array<{ path: string; content: string }>,
): ValidatedAgentSkill[] {
  if (inputFiles.length === 0 || inputFiles.length > AGENT_SKILL_FILE_MAX_COUNT) {
    throw new AgentSkillImportError(
      'skill_archive_file_count',
      `Skill archives must contain 1 to ${AGENT_SKILL_FILE_MAX_COUNT} files.`,
    );
  }
  let expandedBytes = 0;
  const files = inputFiles.map((input) => {
    const path = safeArchivePath(input.path);
    const bytes = Buffer.byteLength(input.content, 'utf8');
    if (bytes > AGENT_SKILL_FILE_MAX_BYTES) {
      throw new AgentSkillImportError(
        'skill_archive_file_too_large',
        `${path} exceeds the 2 MB per-file limit.`,
      );
    }
    expandedBytes += bytes;
    if (expandedBytes > AGENT_SKILL_EXPANDED_MAX_BYTES) {
      throw new AgentSkillImportError(
        'skill_archive_too_large',
        'Expanded skill archive exceeds the 20 MB limit.',
      );
    }
    return { path, content: input.content };
  });
  const skillFiles = files.filter((file) => posix.basename(file.path) === 'SKILL.md');
  if (skillFiles.length === 0) {
    throw new AgentSkillImportError('skill_file_missing', 'Skill archive must contain a SKILL.md file.');
  }

  const slugs = new Set<string>();
  const roots = skillFiles.map((file) => ({ file, root: posix.dirname(file.path) === '.' ? '' : posix.dirname(file.path) }));
  return roots
    .map(({ file, root }) => {
      const metadata = parseSkillFrontmatter(file.content, file.path);
      if (slugs.has(metadata.name)) {
        throw new AgentSkillImportError(
          'skill_slug_duplicate',
          `Skill archive contains duplicate skill slug "${metadata.name}".`,
        );
      }
      slugs.add(metadata.name);
      const rootPrefix = root ? `${root}/` : '';
      const ownedFiles = files
        .filter((candidate) =>
          root ? candidate.path === file.path || candidate.path.startsWith(rootPrefix) : true,
        )
        .map((candidate) => {
          const relativePath = root ? candidate.path.slice(rootPrefix.length) : candidate.path;
          return {
            path: `.kortix/opencode/skills/${metadata.name}/${relativePath}`,
            content: candidate.content,
          };
        })
        .sort((left, right) => {
          const leftSkill = left.path.endsWith('/SKILL.md') ? 0 : 1;
          const rightSkill = right.path.endsWith('/SKILL.md') ? 0 : 1;
          return leftSkill - rightSkill || left.path.localeCompare(right.path);
        });
      return {
        slug: metadata.name,
        name: metadata.name,
        description: metadata.description,
        files: ownedFiles,
      };
    })
    .sort((left, right) => left.slug.localeCompare(right.slug));
}

export async function readAgentSkillArchive(bytes: Uint8Array): Promise<ValidatedAgentSkill[]> {
  if (bytes.byteLength === 0 || bytes.byteLength > AGENT_SKILL_ARCHIVE_MAX_BYTES) {
    throw new AgentSkillImportError(
      'skill_archive_size',
      'Skill archive must contain 1 byte to 10 MB.',
    );
  }
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes, { checkCRC32: true, createFolders: true });
  } catch (error) {
    throw new AgentSkillImportError(
      'skill_archive_invalid',
      `Skill archive is not a valid ZIP file: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const entries = Object.values(zip.files);
  const files: Array<{ path: string; content: string }> = [];
  for (const entry of entries) {
    const original =
      (entry as JSZipObject & { unsafeOriginalName?: string }).unsafeOriginalName ?? entry.name;
    safeArchivePath(original);
    if (symlink(entry)) {
      throw new AgentSkillImportError('skill_archive_symlink', 'Skill archives cannot contain symlinks.');
    }
    if (entry.dir) continue;
    const path = safeArchivePath(entry.name);
    const body = await entry.async('uint8array');
    if (body.byteLength > AGENT_SKILL_FILE_MAX_BYTES) {
      throw new AgentSkillImportError(
        'skill_archive_file_too_large',
        `${path} exceeds the 2 MB per-file limit.`,
      );
    }
    let content: string;
    try {
      content = new TextDecoder('utf-8', { fatal: true }).decode(body);
    } catch {
      throw new AgentSkillImportError(
        'skill_archive_binary_file',
        `${path} is binary. Skill imports currently accept text files only.`,
      );
    }
    files.push({ path, content });
  }
  return validateAgentSkillFiles(files);
}

export function generateAgentSkill(input: { name?: string; brief: string }): ValidatedAgentSkill {
  const brief = input.brief.trim();
  if (!brief || brief.length > 12_000) {
    throw new AgentSkillImportError(
      'skill_brief_invalid',
      'Skill brief must contain 1 to 12000 characters.',
    );
  }
  const inferred = (input.name?.trim() || brief.split(/[.!?\n]/, 1)[0] || 'custom-skill')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  const slug = SLUG_RE.test(inferred) ? inferred : `custom-skill-${crypto.randomUUID().slice(0, 8)}`;
  const description = brief.replace(/\s+/g, ' ').slice(0, 500);
  const content = `---\nname: ${slug}\ndescription: ${JSON.stringify(description)}\n---\n\n# ${slug}\n\n${brief}\n`;
  return validateAgentSkillFiles([{ path: `${slug}/SKILL.md`, content }])[0]!;
}
