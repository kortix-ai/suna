import { describe, expect, test } from 'bun:test';
import { classifyAgentProfileChanges } from './agent-profile-risk';

describe('classifyAgentProfileChanges', () => {
  test('classifies instruction-only edits as low risk', () => {
    const result = classifyAgentProfileChanges(
      { instructions: { prompt: 'Old prompt' } },
      { instructions: { prompt: 'New prompt' } },
    );
    expect(result.highestRisk).toBe('low');
    expect(result.changedSections).toEqual(['instructions']);
  });

  test('reports behavior model and sampling changes as cost-sensitive', () => {
    const result = classifyAgentProfileChanges(
      { instructions: { prompt: 'Answer', model: 'openai/gpt-4o-mini' } },
      {
        instructions: {
          prompt: 'Answer',
          model: 'openai/gpt-4o',
          temperature: 0.7,
          steps: 40,
        },
      },
    );
    expect(result.highestRisk).toBe('low');
    expect(result.impact.cost_sensitive_settings).toEqual(['model', 'steps', 'temperature']);
  });

  test('classifies knowledge and read-only integrations as medium risk', () => {
    const result = classifyAgentProfileChanges(
      {},
      {
        knowledge: ['support-handbook'],
        integrations: [
          {
            profile_id: 'profile-1',
            display_name: 'Drive',
            scopes: ['files.read'],
            can_write: false,
          },
        ],
      },
    );
    expect(result.highestRisk).toBe('medium');
    expect(result.impact.data_access).toEqual(['Drive', 'support-handbook']);
  });

  test('classifies write integrations and schedules as high risk', () => {
    const result = classifyAgentProfileChanges(
      {},
      {
        integrations: [
          {
            profile_id: 'profile-1',
            display_name: 'Slack',
            scopes: ['chat.write'],
            can_write: true,
          },
        ],
        automations: [
          { slug: 'daily-digest', name: 'Daily digest', schedule: '0 9 * * *', enabled: true },
        ],
      },
    );
    expect(result.highestRisk).toBe('high');
    expect(result.impact.actions).toEqual(['Slack']);
    expect(result.impact.schedule_changes).toEqual(['Daily digest']);
  });

  test('reports removed knowledge, integrations, and schedules in the impact summary', () => {
    const result = classifyAgentProfileChanges(
      {
        knowledge: ['support-handbook'],
        integrations: [{ profile_id: 'profile-1', display_name: 'Slack', scopes: ['chat.write'] }],
        automations: [
          { slug: 'daily-digest', name: 'Daily digest', schedule: '0 9 * * *', enabled: true },
        ],
      },
      { knowledge: [], integrations: [], automations: [] },
    );

    expect(result.impact.data_access).toEqual(['Slack', 'support-handbook']);
    expect(result.impact.actions).toEqual(['Slack']);
    expect(result.impact.schedule_changes).toEqual(['Daily digest']);
  });

  test('reports permission expansion and cost-sensitive advanced settings deterministically', () => {
    const base = { advanced: { secrets: [], opencode: { model: 'openai/gpt-4o-mini' } } };
    const draft = {
      advanced: {
        opencode: { model: 'openai/gpt-4o', temperature: 0.7 },
        secrets: ['STRIPE_KEY'],
      },
    };
    const forward = classifyAgentProfileChanges(base, draft);
    const reordered = classifyAgentProfileChanges(base, {
      advanced: {
        secrets: ['STRIPE_KEY'],
        opencode: { temperature: 0.7, model: 'openai/gpt-4o' },
      },
    });
    expect(forward).toEqual(reordered);
    expect(forward.highestRisk).toBe('high');
    expect(forward.impact.data_access).toEqual(['Secret access expanded']);
    expect(forward.impact.cost_sensitive_settings).toEqual(['model', 'temperature']);
  });
});
