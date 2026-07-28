import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { AgentList, type AgentListEntry } from './agent-list';

const AGENTS: AgentListEntry[] = [
  {
    name: 'build',
    path: '.kortix/opencode/agents/build.md',
    description: 'Ships features.',
    mode: 'primary',
  },
  {
    name: 'review',
    path: '.kortix/opencode/agents/review.md',
    description: null,
    mode: 'subagent',
  },
  {
    name: 'retired',
    path: '.kortix/opencode/agents/retired.md',
    description: 'Old one.',
    mode: null,
    enabled: false,
  },
];

function render(extra: Record<string, unknown> = {}, agents: AgentListEntry[] = AGENTS) {
  return renderToStaticMarkup(
    <AgentList agents={agents} selectedPath={AGENTS[0].path} onSelect={() => {}} {...extra} />,
  );
}

describe('rows', () => {
  test('lists every agent it is handed', () => {
    const html = render();
    expect(html).toContain('build');
    expect(html).toContain('review');
    expect(html).toContain('retired');
  });

  test('shows the one-line description under the name', () => {
    expect(render()).toContain('Ships features.');
  });

  test('renders a humanised mode badge, not the raw value', () => {
    const html = render();
    expect(html).toContain('Primary');
    expect(html).toContain('Subagent');
  });

  test('marks the selected row with aria-current', () => {
    expect(render()).toContain('aria-current="true"');
  });

  test('dims a disabled agent instead of hiding it', () => {
    expect(render()).toContain('opacity-60');
  });
});

describe('project default', () => {
  test('stars the default agent', () => {
    expect(render({ defaultAgentName: 'review' })).toContain('Project default');
  });

  test('no star when nothing is the default', () => {
    expect(render()).not.toContain('Project default');
  });
});

describe('search is not duplicated here', () => {
  // The one search field lives in the ProjectSectionPage header. A second one
  // inside the list is exactly the rail-inside-rail this replaced.
  test('renders no search input of its own', () => {
    expect(render()).not.toContain('<input');
  });

  test('an empty result set explains itself', () => {
    const html = render({}, []);
    expect(html).toContain('No agents match that search.');
  });

  test('the empty message is overridable', () => {
    expect(render({ emptyMessage: 'Nothing here.' }, [])).toContain('Nothing here.');
  });
});

describe('accessibility', () => {
  test('the list is a labelled nav of buttons', () => {
    const html = render();
    expect(html).toContain('aria-label="Agents list"');
    expect(html).toContain('type="button"');
  });
});
