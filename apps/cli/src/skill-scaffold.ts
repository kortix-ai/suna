import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// The agentskills.io skill-name rule (see the create-skill skill): lowercase
// letters/digits in single-hyphen-separated groups, no leading/trailing/double
// hyphen. The skill's directory name MUST equal this frontmatter `name`.
const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export interface SkillScaffoldInput {
  /** Project root — the dir containing `.kortix/`. */
  repoRoot: string;
  name: string;
  description: string;
  license?: string;
  /** Overwrite an existing SKILL.md instead of refusing. */
  force?: boolean;
}

export interface SkillScaffoldResult {
  /** Repo-relative path to the written SKILL.md. */
  path: string;
  written: boolean;
}

export function validateSkillName(name: string): string | undefined {
  if (!NAME_RE.test(name)) {
    return `"${name}" is not a valid skill name — use lowercase letters, digits, and single hyphens (e.g. invoice-parse), no leading, trailing, or doubled hyphens.`;
  }
  return undefined;
}

function titleCase(name: string): string {
  return name
    .split('-')
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ');
}

/** Render a spec-valid SKILL.md skeleton. The file MUST start with `---` at
 *  byte 1 (no leading blank line or comment) or the skill loader rejects it. */
export function renderSkillMd(name: string, description: string, license?: string): string {
  const licenseLine = license ? `\nlicense: ${JSON.stringify(license)}` : '';
  return `---
name: ${name}
description: ${JSON.stringify(description)}${licenseLine}
---

# ${titleCase(name)}

## When to use this skill
Describe, concretely, the situations where an agent should load this skill —
the phrases a user would actually type, and the signals that this is the right
tool. A vague description here means the skill never gets triggered.

## Instructions
1. <the first concrete step>

## Examples
Input: <a representative request>
Output: <what a good result looks like>
`;
}

export function applySkillScaffold(input: SkillScaffoldInput): SkillScaffoldResult {
  const nameErr = validateSkillName(input.name);
  if (nameErr) throw new Error(nameErr);

  const relDir = `.kortix/opencode/skills/${input.name}`;
  const relPath = `${relDir}/SKILL.md`;
  const absDir = join(input.repoRoot, relDir);
  const absPath = join(absDir, 'SKILL.md');

  if (existsSync(absPath) && !input.force) {
    throw new Error(
      `${relPath} already exists — pass --force to overwrite, or pick a different name.`,
    );
  }

  mkdirSync(absDir, { recursive: true });
  writeFileSync(absPath, renderSkillMd(input.name, input.description, input.license), 'utf8');
  return { path: relPath, written: true };
}
