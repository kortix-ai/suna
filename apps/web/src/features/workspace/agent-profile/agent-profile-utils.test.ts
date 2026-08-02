import { describe, expect, test } from 'bun:test';

import type { AgentProfile } from '@kortix/sdk';

import {
  activeProfileSections,
  indexedKnowledgeSourceCount,
  nextScheduleRuns,
  profileDraftCount,
  slugifyCapabilityName,
} from './agent-profile-utils';

const profile: AgentProfile = {
  project_id: 'project-1',
  agent_name: 'support',
  is_default: true,
  status: 'draft',
  published_revision: 'published-sha',
  revision: 2,
  sections: {
    instructions: { prompt: 'Published prompt' },
    knowledge: ['published-source'],
    skills: [],
    integrations: [],
    automations: [],
    advanced: {},
  },
  draft: {
    project_id: 'project-1',
    agent_name: 'support',
    revision: 2,
    base_revision: 'published-sha',
    sections: {
      instructions: { prompt: 'Draft prompt' },
      knowledge: ['draft-source'],
    },
    changed_sections: ['instructions', 'knowledge'],
    changes: [],
    highest_risk: 'medium',
    impact: {
      data_access: [],
      actions: [],
      schedule_changes: [],
      cost_sensitive_settings: [],
    },
    active_editors: [],
    updated_at: '2026-08-01T00:00:00.000Z',
    updated_by: 'user-1',
  },
  knowledge_sources: [],
};

describe('agent profile rail state', () => {
  test('uses the complete draft sections while a draft exists', () => {
    expect(activeProfileSections(profile).instructions?.prompt).toBe('Draft prompt');
    expect(activeProfileSections(profile).knowledge).toEqual(['draft-source']);
  });

  test('counts deterministic changed sections instead of raw change records', () => {
    expect(profileDraftCount(profile)).toBe(2);
    expect(profileDraftCount({ ...profile, draft: null, status: 'published' })).toBe(0);
  });

  test('counts hybrid and lexical-only sources as indexed', () => {
    expect(
      indexedKnowledgeSourceCount([
        { status: 'ready' },
        { status: 'degraded' },
        { status: 'pending' },
        { status: 'error' },
      ]),
    ).toBe(2);
  });

  test('creates stable user-facing capability slugs', () => {
    expect(slugifyCapabilityName('Daily Customer Success Brief')).toBe(
      'daily-customer-success-brief',
    );
    expect(slugifyCapabilityName('  Q&A / Triage  ')).toBe('q-a-triage');
  });

  test('previews the next five timezone-aware schedule runs', () => {
    expect(
      nextScheduleRuns('0 0 9 * * 1-5', 'UTC', 5, new Date('2026-08-01T00:00:00.000Z')),
    ).toEqual([
      '2026-08-03T09:00:00.000Z',
      '2026-08-04T09:00:00.000Z',
      '2026-08-05T09:00:00.000Z',
      '2026-08-06T09:00:00.000Z',
      '2026-08-07T09:00:00.000Z',
    ]);
  });
});
