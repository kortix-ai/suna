import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { siteUrl } from './endpoints';

export const AGENT_SKILLS = [
  {
    name: 'kortix-api',
    description: 'Authenticate against and call the Kortix REST API at api.kortix.com/v1.',
  },
  {
    name: 'kortix-sdk',
    description:
      'Install and use the @kortix/sdk TypeScript client instead of hand-rolling HTTP calls.',
  },
  {
    name: 'kortix-agent-content',
    description: 'Read kortix.com content as markdown instead of scraping HTML.',
  },
] as const;

const SKILLS_ROOT = () => path.join(process.cwd(), 'src', 'content', 'agent-skills');

function isPublishedSkill(name: string): boolean {
  return AGENT_SKILLS.some((skill) => skill.name === name);
}

/**
 * Reads a published skill body. The allowlist check is the traversal guard —
 * `name` arrives from a dynamic route segment, so it must never reach
 * path.join unvalidated.
 */
export function readSkillBody(name: string): string | null {
  if (!isPublishedSkill(name)) return null;
  try {
    return fs.readFileSync(path.join(SKILLS_ROOT(), name, 'SKILL.md'), 'utf8');
  } catch {
    return null;
  }
}

export function skillUrl(name: string): string {
  return siteUrl(`/.well-known/agent-skills/${name}/SKILL.md`);
}

/**
 * Agent Skills Discovery RFC v0.2.0. Digests are computed from the same bytes
 * the SKILL.md route serves, so the index cannot go stale against its content.
 */
export function buildSkillsIndex(): {
  $schema: string;
  skills: { name: string; type: 'skill'; description: string; url: string; sha256: string }[];
} {
  return {
    $schema: 'https://agentskills.io/schemas/v0.2.0/index.json',
    skills: AGENT_SKILLS.flatMap((skill) => {
      const body = readSkillBody(skill.name);
      if (body === null) return [];
      return [
        {
          name: skill.name,
          type: 'skill' as const,
          description: skill.description,
          url: skillUrl(skill.name),
          sha256: createHash('sha256').update(body, 'utf8').digest('hex'),
        },
      ];
    }),
  };
}
