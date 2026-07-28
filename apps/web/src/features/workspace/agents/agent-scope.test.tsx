import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { AgentScope, ScopeEditor, ScopeRow, grantSetEqual } from './agent-scope';

const OPTIONS = [
  { id: 'OPENAI_API_KEY', label: 'OPENAI_API_KEY' },
  { id: 'STRIPE_KEY', label: 'STRIPE_KEY' },
];

function editor(value: 'all' | string[], extra: Record<string, unknown> = {}) {
  return renderToStaticMarkup(
    <ScopeEditor
      label="Secrets"
      allLabel="All the launcher can see"
      emptyLabel="No secrets in this project yet."
      value={value}
      options={OPTIONS}
      onChange={() => {}}
      {...extra}
    />,
  );
}

describe('AgentScope prop guard', () => {
  test('an OpenCode agent with no manifest scope renders nothing', () => {
    const html = renderToStaticMarkup(
      <AgentScope projectId="p1" agentName="build" scope={undefined} />,
    );
    expect(html).toBe('');
  });
});

describe('ScopeRow', () => {
  test('"all" reads as All', () => {
    expect(renderToStaticMarkup(<ScopeRow label="CLI" value="all" />)).toContain('All');
  });

  test('an empty list reads as None, not as blank', () => {
    expect(renderToStaticMarkup(<ScopeRow label="CLI" value={[]} />)).toContain('None');
  });

  test('a concrete list shows every entry', () => {
    const html = renderToStaticMarkup(<ScopeRow label="CLI" value={['sessions', 'secrets']} />);
    expect(html).toContain('sessions');
    expect(html).toContain('secrets');
  });
});

describe('ScopeEditor', () => {
  test('offers all three modes', () => {
    const html = editor('all');
    expect(html).toContain('>all<');
    expect(html).toContain('>specific<');
    expect(html).toContain('>none<');
  });

  test('"all" explains what all means and hides the checklist', () => {
    const html = editor('all');
    expect(html).toContain('All the launcher can see');
    expect(html).not.toContain('OPENAI_API_KEY');
  });

  test('a concrete list opens the checklist with the picks marked', () => {
    const html = editor(['OPENAI_API_KEY']);
    expect(html).toContain('OPENAI_API_KEY');
    expect(html).toContain('aria-pressed="true"');
  });

  test('a declared name that no longer exists stays visible, flagged', () => {
    const html = editor(['GONE_KEY']);
    expect(html).toContain('GONE_KEY');
    expect(html).toContain('missing');
  });

  test('an empty project says so rather than showing a dead box', () => {
    const html = editor(['PICKED'], { options: [] });
    expect(html).toContain('PICKED');
    expect(editor([], { options: [] })).not.toContain('No secrets in this project yet.');
  });
});

describe('grantSetEqual', () => {
  test('"all" only equals "all"', () => {
    expect(grantSetEqual('all', 'all')).toBe(true);
    expect(grantSetEqual('all', [])).toBe(false);
    expect(grantSetEqual([], 'all')).toBe(false);
  });

  test('order does not matter', () => {
    expect(grantSetEqual(['a', 'b'], ['b', 'a'])).toBe(true);
  });

  test('different lengths differ', () => {
    expect(grantSetEqual(['a'], ['a', 'b'])).toBe(false);
  });
});
