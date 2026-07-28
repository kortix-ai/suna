import { describe, expect, mock, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';

mock.module('next/navigation', () => ({
  useRouter: () => ({ push: () => {} }),
}));

import { AgentsDemo } from './agents-demo';
import { DEMO_AGENTS } from './demo-agents-data';

const SOURCE = readFileSync(fileURLToPath(new URL('./agents-demo.tsx', import.meta.url)), 'utf8');

const html = renderToStaticMarkup(<AgentsDemo />);

describe('content', () => {
  test('renders every starter agent by its real name', () => {
    expect(DEMO_AGENTS.length).toBeGreaterThan(0);
    for (const agent of DEMO_AGENTS) {
      expect(html).toContain(agent.name);
    }
  });

  test('renders each agent description, not a placeholder', () => {
    for (const agent of DEMO_AGENTS) {
      const opening = agent.description.slice(0, 40);
      expect(opening.length).toBe(40);
      expect(html).toContain(opening.replace(/&/g, '&amp;').replace(/</g, '&lt;'));
    }
  });

  test('is the real screen: same title and same one-line description', () => {
    expect(html).toContain('Agents');
    expect(html).toContain(
      'Reusable personas that run your sessions, each with its own prompt and model.',
    );
  });

  test('says what an agent is by showing its mode', () => {
    expect(html).toContain('Primary');
  });

  test('marks the project default the way the signed-in list does', () => {
    expect(html).toContain('Project default');
    expect(DEMO_AGENTS.filter((a) => a.isDefault)).toHaveLength(1);
  });
});

describe('honesty', () => {
  test('claims no state a signed-out visitor could not have', () => {
    expect(html).not.toContain('last run');
    expect(html).not.toContain('Connected');
    expect(html).not.toContain('sessions run');
  });

  test('fetches nothing — there is no session to fetch with', () => {
    expect(SOURCE).not.toContain("from '@kortix/sdk'");
    expect(SOURCE).not.toContain('useQuery');
  });

  test('links the same agent docs the signed-in screen links', () => {
    const view = readFileSync(
      fileURLToPath(
        new URL('../../workspace/customize/sections/view/agents-view.tsx', import.meta.url),
      ),
      'utf8',
    );
    expect(view).toContain("'https://opencode.ai/docs/agents/'");
    expect(SOURCE).toContain("'https://opencode.ai/docs/agents/'");
  });
});

describe('gating', () => {
  test('every control routes to sign-in', () => {
    expect(SOURCE).toContain("const onGate = () => gate('/');");
    expect(SOURCE).toContain('onClick={onGate}');
    expect(SOURCE).toContain('onGate={onGate}');
    expect(SOURCE).toContain('search={demoSearch(');
  });

  test('exactly one h1, so the shared shell contract still holds', () => {
    expect(html.match(/<h1/g)).toHaveLength(1);
  });
});
