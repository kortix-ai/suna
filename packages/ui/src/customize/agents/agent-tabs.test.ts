import { describe, expect, test } from 'bun:test';

import type { AgentConfigSectionKey } from '../sections/view/agent-editor';
import {
  AGENT_TABS,
  agentLocationHref,
  changedTabs,
  closestAgentName,
  resolveAgentLocation,
  sectionLocationHref,
} from './agent-tabs';

describe('changedTabs', () => {
  test('no change, no tab', () => {
    expect(changedTabs({ skills: ['a'] }, { skills: ['a'] })).toEqual([]);
  });
  test('each field lands on the tab that edits it', () => {
    expect(
      changedTabs(
        { behavior: { prompt: 'new', model: 'x/y' }, connectors: ['github'], enabled: false },
        { behavior: { prompt: 'old' } },
      ),
    ).toEqual(['overview', 'instructions', 'access', 'runtime']);
  });
});

describe('closestAgentName', () => {
  test('a typo finds the agent, a stranger finds none', () => {
    expect(closestAgentName('reseacher', ['researcher', 'release-writer'])).toBe('researcher');
    expect(closestAgentName('market-scan', ['researcher', 'kortix'])).toBeNull();
  });
});

const ALL_VIEWS: AgentConfigSectionKey[] = [
  'skills',
  'connectors',
  'secrets',
  'apps',
  'drives',
  'actions',
  'model',
  'tools',
  'workspace',
];
const at = (params: Partial<Record<'tab' | 'view' | 'section', string>>, views = ALL_VIEWS) =>
  resolveAgentLocation(
    { tab: params.tab ?? null, view: params.view ?? null, section: params.section ?? null },
    AGENT_TABS,
    views,
  );

describe('resolveAgentLocation', () => {
  test('no params opens Overview', () => {
    expect(at({})).toEqual({ tab: 'overview', view: null });
  });

  test('Access opens its first view, Runtime opens Model', () => {
    expect(at({ tab: 'access' })).toEqual({ tab: 'access', view: 'skills' });
    expect(at({ tab: 'runtime' })).toEqual({ tab: 'runtime', view: 'model' });
  });

  test('view=permissions is the Kortix permissions view', () => {
    expect(at({ tab: 'access', view: 'permissions' })).toEqual({ tab: 'access', view: 'actions' });
  });

  test('every legacy ?section= maps to a tab and view', () => {
    const cases: Record<string, { tab: string; view: string | null }> = {
      overview: { tab: 'overview', view: null },
      instructions: { tab: 'instructions', view: null },
      people: { tab: 'people', view: null },
      triggers: { tab: 'triggers', view: null },
      basics: { tab: 'overview', view: null },
      skills: { tab: 'access', view: 'skills' },
      connectors: { tab: 'access', view: 'connectors' },
      secrets: { tab: 'access', view: 'secrets' },
      apps: { tab: 'access', view: 'apps' },
      drives: { tab: 'access', view: 'drives' },
      actions: { tab: 'access', view: 'actions' },
      permissions: { tab: 'access', view: 'actions' },
      model: { tab: 'runtime', view: 'model' },
      tools: { tab: 'runtime', view: 'tools' },
      workspace: { tab: 'runtime', view: 'workspace' },
    };
    for (const [section, expected] of Object.entries(cases)) {
      expect(at({ section })).toEqual(expected as never);
    }
  });

  test('a view the agent lacks falls back to the first one it has', () => {
    expect(at({ tab: 'access', view: 'drives' }, ['skills', 'connectors'])).toEqual({
      tab: 'access',
      view: 'skills',
    });
  });

  test('a tab the agent lacks falls back to its first tab', () => {
    expect(resolveAgentLocation({ tab: 'access', view: null, section: null }, ['overview', 'people'], [])).toEqual({
      tab: 'overview',
      view: null,
    });
  });
});

describe('hrefs', () => {
  test('Overview is the bare path', () => {
    expect(agentLocationHref('/a', 'overview')).toBe('/a');
  });
  test('a view writes tab and view', () => {
    expect(agentLocationHref('/a', 'access', 'actions')).toBe('/a?tab=access&view=permissions');
    expect(sectionLocationHref('/a', 'basics')).toBe('/a');
    expect(sectionLocationHref('/a', 'model')).toBe('/a?tab=runtime&view=model');
  });
});
