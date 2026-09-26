import { lstatSync, readdirSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Every repo skill lives in .agents/skills/<name>/. .claude/skills/<name> is a
// symlink to it, so Claude Code and every other agent read the same files.

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const AGENTS = join(REPO_ROOT, '.agents', 'skills');
const CLAUDE = join(REPO_ROOT, '.claude', 'skills');

const visible = (name: string) => !name.startsWith('.');

describe('the skills layout', () => {
  it('keeps each skill as a real directory in .agents/skills with a SKILL.md', () => {
    const offenders = readdirSync(AGENTS)
      .filter(visible)
      .filter((name) => {
        const dir = join(AGENTS, name);
        return !lstatSync(dir).isDirectory() || !readdirSync(dir).includes('SKILL.md');
      });
    expect(offenders).toEqual([]);
  });

  it('links every .agents skill from .claude/skills, and nothing else lives there', () => {
    const expected = readdirSync(AGENTS).filter(visible).sort();
    const present = readdirSync(CLAUDE).filter(visible).sort();
    expect(present).toEqual(expected);
    const wrong = present.filter((name) => {
      const link = join(CLAUDE, name);
      return !lstatSync(link).isSymbolicLink() || readlinkSync(link) !== `../../.agents/skills/${name}`;
    });
    expect(wrong).toEqual([]);
  });
});
