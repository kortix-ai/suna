/**
 * Skills feature types.
 *
 * Skills are SKILL.md files with YAML frontmatter (name + description)
 * and a Markdown body containing instructions. They live in well-known
 * directories and are discovered automatically by the OpenCode server.
 */

// ---------------------------------------------------------------------------
// Core skill type (matches the OpenCode SDK response)
// ---------------------------------------------------------------------------

export interface Skill {
  /** Unique skill identifier (lowercase, hyphenated) */
  name: string;
  /** What the skill does and when to load it */
  description: string;
  /** Absolute filesystem path to the SKILL.md file */
  location: string;
  /** Full file content (frontmatter + body) */
  content: string;
}

// ---------------------------------------------------------------------------
// Skill source classification
// ---------------------------------------------------------------------------

export type SkillSource = 'project' | 'global' | 'external';

export function getSkillSource(location: string): SkillSource {
  if (location.includes('/.opencode/')) return 'project';
  if (
    location.includes('/.claude/') ||
    location.includes('/.agents/')
  )
    return 'external';
  if (location.includes('/.config/')) return 'global';
  return 'project';
}

export const SOURCE_META: Record<
  SkillSource,
  { label: string; color: string }
> = {
  project: { label: 'Project', color: 'text-blue-500 bg-blue-500/10' },
  global: { label: 'Global', color: 'text-emerald-500 bg-emerald-500/10' },
  external: {
    label: 'External',
    color: 'text-violet-500 bg-violet-500/10',
  },
};

// ---------------------------------------------------------------------------
// CRUD inputs
// ---------------------------------------------------------------------------

export interface CreateSkillInput {
  /** Skill name: 1-64 chars, lowercase alphanumeric with hyphens */
  name: string;
  /** What the skill does — always visible to agents (1-1024 chars) */
  description: string;
  /** Markdown body (instructions, workflows, etc.) */
  body: string;
}

export interface UpdateSkillInput {
  /** Absolute path to the existing SKILL.md file */
  location: string;
  /** Updated description */
  description: string;
  /** Updated markdown body */
  body: string;
}

export interface DeleteSkillInput {
  /** Absolute path to the skill directory (parent of SKILL.md) */
  location: string;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** Name must be lowercase alphanumeric with single hyphens, 1-64 chars */
export const SKILL_NAME_REGEX = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const SKILL_NAME_MAX_LENGTH = 64;
export const SKILL_DESCRIPTION_MAX_LENGTH = 1024;

export function validateSkillName(name: string): string | null {
  if (!name) return 'Name is required';
  if (name.length > SKILL_NAME_MAX_LENGTH)
    return `Name must be ${SKILL_NAME_MAX_LENGTH} characters or fewer`;
  if (!SKILL_NAME_REGEX.test(name))
    return 'Name must be lowercase letters, numbers, and hyphens (e.g. my-skill)';
  return null;
}

export function validateSkillDescription(description: string): string | null {
  if (!description.trim()) return 'Description is required';
  if (description.length > SKILL_DESCRIPTION_MAX_LENGTH)
    return `Description must be ${SKILL_DESCRIPTION_MAX_LENGTH} characters or fewer`;
  return null;
}

// ---------------------------------------------------------------------------
// Serialization helpers
// ---------------------------------------------------------------------------

/**
 * Build the full SKILL.md file content from structured fields.
 */
export function buildSkillFileContent(
  name: string,
  description: string,
  body: string,
): string {
  const lines = [
    '---',
    `name: ${name}`,
    `description: ${JSON.stringify(description)}`,
    '---',
    '',
    body,
  ];
  return lines.join('\n');
}

/**
 * Parse a SKILL.md file into structured fields.
 * Returns null if the file doesn't have valid frontmatter.
 */
export function parseSkillFileContent(content: string): {
  name: string;
  description: string;
  body: string;
} | null {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (!match) return null;

  const frontmatter = match[1];
  const body = (match[2] ?? '').trim();

  let name = '';
  let description = '';

  for (const line of frontmatter.split('\n')) {
    const nameMatch = line.match(/^name:\s*(.+)$/);
    if (nameMatch) {
      name = nameMatch[1].trim().replace(/^["']|["']$/g, '');
    }
    const descMatch = line.match(/^description:\s*(.+)$/);
    if (descMatch) {
      let desc = descMatch[1].trim();
      // Handle JSON-quoted strings
      if (desc.startsWith('"') && desc.endsWith('"')) {
        try {
          desc = JSON.parse(desc);
        } catch {
          desc = desc.slice(1, -1);
        }
      }
      // Handle single-quoted strings
      if (desc.startsWith("'") && desc.endsWith("'")) {
        desc = desc.slice(1, -1);
      }
      description = desc;
    }
  }

  if (!name) return null;
  return { name, description, body };
}

// ---------------------------------------------------------------------------
// Filter types
// ---------------------------------------------------------------------------

export type SkillFilterTab = 'all' | SkillSource;

export const SKILL_FILTER_TABS: { value: SkillFilterTab; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'project', label: 'Project' },
  { value: 'global', label: 'Global' },
  { value: 'external', label: 'External' },
];
