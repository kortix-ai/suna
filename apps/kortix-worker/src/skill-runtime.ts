import path from 'node:path';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type } from 'typebox';

/** Immutable skill bytes compiled from the session's exact Git SHA. */
export interface PiSkill {
  name: string;
  description?: string;
  /** Repository-relative `SKILL.md` path. */
  location: string;
  /** Markdown body with frontmatter removed. */
  content: string;
  /** Sampled relative support paths. The worker never reads their bytes. */
  files: string[];
}

export interface PiSkillInfo {
  name: string;
  description?: string;
  location: string;
  content: string;
}

const skillSchema = Type.Object({
  name: Type.String({ minLength: 1, description: 'The exact name from available_skills' }),
});

function xml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function environmentLocation(skill: PiSkill, workspace: string): string {
  if (path.posix.isAbsolute(skill.location) || skill.location.split('/').includes('..')) {
    throw new Error(`Pi skill "${skill.name}" has an unsafe source location`);
  }
  return path.posix.join(workspace, skill.location);
}

export function projectSkillInfo(skill: PiSkill, workspace: string): PiSkillInfo {
  return {
    name: skill.name,
    ...(skill.description !== undefined ? { description: skill.description } : {}),
    location: environmentLocation(skill, workspace),
    content: skill.content,
  };
}

function availableSkillsDescription(skills: readonly PiSkill[]): string {
  const described = skills.filter((skill) => skill.description !== undefined);
  if (described.length === 0) return 'No skills are currently available.';
  return [
    'Load a specialized skill when the task matches one of the skills below.',
    '',
    '<available_skills>',
    ...described.flatMap((skill) => [
      '  <skill>',
      `    <name>${xml(skill.name)}</name>`,
      `    <description>${xml(skill.description ?? '')}</description>`,
      '  </skill>',
    ]),
    '</available_skills>',
  ].join('\n');
}

/**
 * Load only the Markdown already resident in the compiled artifact.
 *
 * Support files stay in the environment checkout. The returned paths guide
 * the model to the remote `read` or `bash` tools; this module performs no file
 * read and cannot execute a support script inside the worker.
 */
export function createSkillTool(
  skills: readonly PiSkill[],
  workspace: string,
): AgentTool<typeof skillSchema> {
  const byName = new Map(skills.map((skill) => [skill.name, skill]));
  const available = [...byName.keys()].sort();
  return {
    name: 'skill',
    label: 'skill',
    description: availableSkillsDescription(skills),
    parameters: skillSchema,
    executionMode: 'sequential',
    async execute(_toolCallId, { name }) {
      const skill = byName.get(name);
      if (!skill) {
        throw new Error(
          `Skill "${name}" not found. Available skills: ${available.join(', ') || 'none'}`,
        );
      }
      const location = environmentLocation(skill, workspace);
      const dir = path.posix.dirname(location);
      const files = skill.files.map((file) => path.posix.join(dir, file));
      const output = [
        `<skill_content name="${xml(skill.name)}">`,
        `# Skill: ${skill.name}`,
        '',
        skill.content.trim(),
        '',
        `Base directory for this skill: ${dir}`,
        'Relative paths in this skill (for example scripts/ and references/) are relative to this base directory.',
        'Support files execute or load only through environment tools. The file list is sampled.',
        '',
        '<skill_files>',
        files.map((file) => `<file>${xml(file)}</file>`).join('\n'),
        '</skill_files>',
        '</skill_content>',
      ].join('\n');
      return {
        content: [{ type: 'text', text: output }],
        details: { name: skill.name, dir },
      };
    },
  };
}
