/**
 * The honesty gate for the signed-out demos.
 *
 * The catalogue endpoints are project-scoped, so the logged-out Skills,
 * Automations and Agents screens are served from static frontend data. Static
 * data rots quietly and, worse, invites invention. This test re-reads the real
 * files in packages/starter and fails if a demo name, description, mode or cron
 * expression is not literally in one of them.
 *
 * If this fails after someone edits the starter templates, the fix is to update
 * the demo data to match the templates — never the other way round.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEMO_AGENTS, DEMO_AGENTS_SOURCE } from './demo-agents-data';
import { DEMO_AUTOMATIONS, WEBHOOK_CADENCE } from './demo-automations-data';
import { DEMO_SKILLS, DEMO_SKILLS_SOURCE } from './demo-skills-data';

const REPO_ROOT = fileURLToPath(new URL('../../../../../../', import.meta.url));

const read = (relative: string) => readFileSync(join(REPO_ROOT, relative), 'utf8');

/** Minimal YAML frontmatter reader — enough for `name:`, `description:`, `mode:`. */
function frontmatter(text: string): Record<string, string> {
  const lines = text.split('\n');
  if (lines[0]?.trim() !== '---') return {};
  const end = lines.indexOf('---', 1);
  const out: Record<string, string> = {};
  let key: string | null = null;
  for (const line of lines.slice(1, end === -1 ? lines.length : end)) {
    const match = /^([a-zA-Z_][\w-]*):\s?(.*)$/.exec(line);
    if (match) {
      key = match[1];
      out[key] = match[2];
    } else if (key && line.trim()) {
      out[key] += ` ${line.trim()}`;
    }
  }
  for (const [k, raw] of Object.entries(out)) {
    const value = raw.trim();
    out[k] =
      value.startsWith('"') && value.endsWith('"')
        ? value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\')
        : value;
  }
  return out;
}

describe('skills come from packages/starter', () => {
  const dirs = readdirSync(join(REPO_ROOT, DEMO_SKILLS_SOURCE)).sort();

  test('every skill the base template ships is shown, and nothing else', () => {
    const shown = DEMO_SKILLS.map((s) => s.name).sort();
    expect(shown).toEqual(dirs);
  });

  for (const skill of DEMO_SKILLS) {
    test(`${skill.name} matches its SKILL.md frontmatter`, () => {
      const fm = frontmatter(read(join(DEMO_SKILLS_SOURCE, skill.name, 'SKILL.md')));
      expect(fm.name).toBe(skill.name);
      expect(skill.description).toBe(fm.description);
    });
  }

  test('each path points at a file that exists', () => {
    for (const skill of DEMO_SKILLS) {
      expect(skill.path).toBe(`.kortix/opencode/skills/${skill.name}/SKILL.md`);
      expect(read(join(DEMO_SKILLS_SOURCE, skill.name, 'SKILL.md')).length).toBeGreaterThan(0);
    }
  });
});

describe('agents come from packages/starter', () => {
  test('every agent the base template ships is shown, and nothing else', () => {
    const files = readdirSync(join(REPO_ROOT, DEMO_AGENTS_SOURCE))
      .filter((f) => f.endsWith('.md'))
      .map((f) => f.replace(/\.md$/, ''))
      .sort();
    expect(DEMO_AGENTS.map((a) => a.name).sort()).toEqual(files);
  });

  for (const agent of DEMO_AGENTS) {
    test(`${agent.name} matches its agent file frontmatter`, () => {
      const fm = frontmatter(read(join(DEMO_AGENTS_SOURCE, `${agent.name}.md`)));
      expect(agent.description).toBe(fm.description);
      expect(agent.mode).toBe(fm.mode);
      expect(agent.path).toBe(`.kortix/opencode/agents/${agent.name}.md`);
    });
  }

  test('the starred agent is the manifest default, not a favourite we picked', () => {
    const manifest = read('packages/starter/templates/base/kortix.yaml');
    const starred = DEMO_AGENTS.filter((a) => a.isDefault);
    expect(starred).toHaveLength(1);
    expect(manifest).toContain(`default_agent: ${starred[0].name}`);
  });
});

describe('automations come from real trigger manifests', () => {
  for (const automation of DEMO_AUTOMATIONS) {
    test(`${automation.name} is declared in its manifest`, () => {
      const manifest = read(automation.manifest);
      expect(manifest).toContain(`- slug: ${automation.slug}`);
      expect(manifest).toContain(`name: ${automation.name}`);
      expect(manifest).toContain(`type: ${automation.type}`);
      if (automation.type === 'cron') {
        expect(automation.cron).toBeTruthy();
        expect(manifest).toContain(`cron: "${automation.cron}"`);
      } else {
        expect(automation.cron).toBeUndefined();
      }
    });
  }

  test('slugs are unique, so React keys and the list stay stable', () => {
    const slugs = DEMO_AUTOMATIONS.map((a) => a.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  test('shows both kinds of trigger — a schedule and an event', () => {
    expect(DEMO_AUTOMATIONS.some((a) => a.type === 'cron')).toBe(true);
    expect(DEMO_AUTOMATIONS.some((a) => a.type === 'webhook')).toBe(true);
  });

  test('the webhook cadence phrase is the product’s own', () => {
    const view = readFileSync(
      fileURLToPath(new URL('../../workspace/automations/automations-view.tsx', import.meta.url)),
      'utf8',
    );
    expect(view).toContain(`'${WEBHOOK_CADENCE}'`);
  });
});
