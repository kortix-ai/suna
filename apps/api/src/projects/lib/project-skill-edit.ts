import { stringify as stringifyYaml } from 'yaml';
import { KORTIX_SKILL_PREFIX, SLUG_RE } from '@kortix/manifest-schema';
import { isRecord } from '@kortix/shared/guards';
import { manifestWrites } from '../manifest-io';
import type { ParsedManifest } from '../trigger-types';

/** The manifest part of the same commit that creates/deletes the skill folder. */
export function projectSkillManifestEdit(manifest: ParsedManifest | null, slug: string, action: 'create' | 'delete') {
  if (!manifest || manifest.schemaVersion !== 3) return { files: [], alsoExpect: [], expectedFileRevision: undefined };
  if (!SLUG_RE.test(slug) || slug.startsWith(KORTIX_SKILL_PREFIX)) throw new Error('Invalid or reserved skill slug');
  const skills = isRecord(manifest.raw.skills) ? { ...manifest.raw.skills } : {};
  const folder = `skills/${slug}`;
  if (action === 'create') {
    if (Object.hasOwn(skills, slug) || Object.values(skills).includes(folder)) throw new Error(`Skill "${slug}" already exists`);
    skills[slug] = folder;
  } else {
    const removed = Object.keys(skills).filter((name) => skills[name] === folder);
    for (const name of removed) delete skills[name];
    const agents = isRecord(manifest.raw.agents) ? structuredClone(manifest.raw.agents) : undefined;
    for (const agent of Object.values(agents ?? {})) {
      if (isRecord(agent) && Array.isArray(agent.skills)) agent.skills = agent.skills.filter((name) => !removed.includes(name));
    }
    manifest = { ...manifest, raw: { ...manifest.raw, ...(agents ? { agents } : {}) } };
  }
  const edited = { ...manifest, raw: { ...manifest.raw, skills } };
  return {
    ...manifestWrites(edited),
    expectedFileRevision: manifest.revision === undefined ? undefined : {
      path: manifest.path || 'kortix.yaml', sha: manifest.revision, candidatePaths: manifest.candidatePaths,
    },
  };
}

/** The committed file's full text: frontmatter (real YAML, the same writer
 *  `serializeAgentMarkdown` uses) plus a starter body. `lineWidth: 0` keeps
 *  every scalar on one line, which is what the summary's frontmatter reader
 *  parses. */
export function renderSkillMarkdown(skill: { name: string; description?: string }, slug: string): string {
  const frontmatter: Record<string, string> = { name: slug };
  if (skill.description) frontmatter.description = skill.description;
  const header = stringifyYaml(frontmatter, { lineWidth: 0 }).trimEnd();
  const body = [
    `# ${skill.name}`,
    '',
    ...(skill.description ? [skill.description, ''] : []),
    'Describe when the agent should load this skill and what to do. Edit this file',
    'in the repo, or ask an agent in chat to extend it.',
    '',
  ].join('\n');
  return `---\n${header}\n---\n\n${body}`;
}

