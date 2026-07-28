import { describe, expect, mock, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';

// The demo gates through useSignInGate, which reaches for the app router.
// There is none in a static render, so stand one up.
mock.module('next/navigation', () => ({
  useRouter: () => ({ push: () => {} }),
}));

import { DEMO_SKILLS } from './demo-skills-data';
import { SkillsDemo } from './skills-demo';

const SOURCE = readFileSync(fileURLToPath(new URL('./skills-demo.tsx', import.meta.url)), 'utf8');

const html = renderToStaticMarkup(<SkillsDemo />);

describe('content', () => {
  test('renders every starter skill, by its real name', () => {
    expect(DEMO_SKILLS.length).toBeGreaterThan(0);
    for (const skill of DEMO_SKILLS) {
      expect(html).toContain(skill.name);
    }
  });

  test('renders each skill description, not a placeholder', () => {
    for (const skill of DEMO_SKILLS) {
      // The first clause is enough — the card clamps to two lines, but the
      // text it clamps has to be the file's own.
      const opening = (skill.description ?? '').slice(0, 40);
      expect(opening.length).toBe(40);
      expect(html).toContain(opening.replace(/&/g, '&amp;').replace(/</g, '&lt;'));
    }
  });

  test('is the real screen: same title and same one-line description', () => {
    expect(html).toContain('Skills');
    expect(html).toContain('Reusable capabilities and slash commands your agents can call.');
  });

  test('keeps the two-column card grid from the design references', () => {
    expect(html).toContain('sm:grid-cols-2');
  });
});

describe('honesty', () => {
  test('claims no state a signed-out visitor could not have', () => {
    expect(html).not.toContain('Connected');
    expect(html).not.toContain('Installed');
    expect(html).not.toContain('last run');
  });

  test('fetches nothing — there is no session to fetch with', () => {
    expect(SOURCE).not.toContain("from '@kortix/sdk'");
    expect(SOURCE).not.toContain('useQuery');
  });

  test('renders the product card, so the demo cannot drift from the product', () => {
    expect(SOURCE).toContain("import { SkillCard } from '@/features/workspace/skills/skill-card'");
  });
});

describe('gating', () => {
  test('every control routes to sign-in', () => {
    expect(SOURCE).toContain("const onGate = () => gate('/');");
    expect(SOURCE).toContain('onOpen={onGate}');
    expect(SOURCE).toContain('onEdit={onGate}');
    expect(SOURCE).toContain('onGate={onGate}');
    expect(SOURCE).toContain('search={demoSearch(');
  });

  test('exactly one h1, so the shared shell contract still holds', () => {
    expect(html.match(/<h1/g)).toHaveLength(1);
  });
});
