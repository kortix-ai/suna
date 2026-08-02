import { describe, expect, test } from 'bun:test';
import { parseManifestString, extractTriggers } from '../triggers';
import { parseAgentMarkdown } from './agent-markdown';
import { composeAgentProfileFiles } from './agent-profile-compose';

const MANIFEST = `
kortix_version: 2
default_agent: support
agents:
  support:
    connectors: [github]
    knowledge: [old-runbook]
    skills: [old-skill]
    workspace: read
  sales:
    knowledge: []
triggers:
  - slug: daily-support
    name: Daily support
    type: cron
    agent: support
    enabled: true
    cron: "0 9 * * *"
    timezone: UTC
    prompt: Review support tickets.
  - slug: sales-digest
    name: Sales digest
    type: cron
    agent: sales
    enabled: true
    cron: "0 10 * * *"
    timezone: UTC
    prompt: Review sales activity.
`;

describe('composeAgentProfileFiles', () => {
  test('publishes every capability in one deterministic file set without touching other agents', () => {
    const manifest = parseManifestString(MANIFEST, 'yaml', 'kortix.yaml');
    if (!manifest) throw new Error('manifest did not parse');
    const result = composeAgentProfileFiles({
      manifest,
      agentName: 'support',
      behavior: parseAgentMarkdown(`---
description: Support specialist
mode: primary
---

Old instructions.
`),
      sections: {
        instructions: {
          description: 'Support specialist',
          mode: 'primary',
          model: 'openai/gpt-4o',
          prompt: 'Use private knowledge and cite every answer.',
        },
        integrations: [
          {
            profile_id: 'slack-profile',
            slug: 'slack',
            provider: 'slack',
            display_name: 'Slack',
            scopes: ['chat.write'],
            can_write: true,
            status: 'pending_publication',
            error: null,
          },
        ],
        knowledge: ['support-runbook'],
        skills: [
          {
            slug: 'ticket-triage',
            name: 'Ticket triage',
            description: null,
            origin: 'project',
            status: 'available',
          },
        ],
        automations: [
          {
            slug: 'daily-support',
            name: 'Daily support',
            enabled: false,
            schedule: '0 8 * * *',
            timezone: 'America/New_York',
            next_runs: [],
            status: 'paused',
          },
          {
            slug: 'weekly-support',
            name: 'Weekly support',
            prompt: 'Summarize unresolved support trends.',
            enabled: true,
            schedule: '0 9 * * 1',
            timezone: 'UTC',
            next_runs: [],
            status: 'pending_publication',
          },
        ],
        advanced: { enabled: true, workspace: 'branch' },
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.files.map((file) => file.path)).toEqual([
      'kortix.yaml',
      '.kortix/opencode/agents/support.md',
    ]);
    expect(result.technicalDiff.map((entry) => entry.path)).toEqual([
      'kortix.yaml',
      '.kortix/opencode/agents/support.md',
    ]);

    const nextManifest = parseManifestString(result.files[0]!.content, 'yaml', 'kortix.yaml');
    if (!nextManifest) throw new Error('next manifest did not parse');
    const support = (nextManifest.raw.agents as Record<string, any>).support;
    const sales = (nextManifest.raw.agents as Record<string, any>).sales;
    expect(support.connectors).toEqual(['slack']);
    expect(support.knowledge).toEqual(['support-runbook']);
    expect(support.skills).toEqual(['ticket-triage']);
    expect(support.workspace).toBe('branch');
    expect(sales.knowledge).toEqual([]);

    const triggers = extractTriggers(nextManifest).specs;
    expect(triggers.find((entry) => entry.slug === 'daily-support')).toMatchObject({
      agent: 'support',
      enabled: false,
      cron: '0 8 * * *',
      timezone: 'America/New_York',
      promptTemplate: 'Review support tickets.',
    });
    expect(triggers.find((entry) => entry.slug === 'weekly-support')).toMatchObject({
      agent: 'support',
      enabled: true,
      cron: '0 9 * * 1',
      promptTemplate: 'Summarize unresolved support trends.',
    });
    expect(triggers.find((entry) => entry.slug === 'sales-digest')).toMatchObject({
      agent: 'sales',
      enabled: true,
    });

    const behavior = parseAgentMarkdown(result.files[1]!.content);
    expect(behavior.frontmatter.model).toBe('openai/gpt-4o');
    expect(behavior.body).toBe('Use private knowledge and cite every answer.');
  });

  test('rejects a schedule slug owned by another agent', () => {
    const manifest = parseManifestString(MANIFEST, 'yaml', 'kortix.yaml');
    if (!manifest) throw new Error('manifest did not parse');
    const result = composeAgentProfileFiles({
      manifest,
      agentName: 'support',
      behavior: { frontmatter: {}, body: 'Prompt' },
      sections: {
        automations: [
          {
            slug: 'sales-digest',
            name: 'Collision',
            enabled: true,
            schedule: '0 9 * * *',
            timezone: 'UTC',
            next_runs: [],
            status: 'pending_publication',
          },
        ],
      },
    });
    expect(result).toMatchObject({ ok: false, code: 'trigger_slug_conflict' });
  });

  test('publishes validated pending skill files in the same deterministic file set', () => {
    const manifest = parseManifestString(MANIFEST, 'yaml', 'kortix.yaml');
    if (!manifest) throw new Error('manifest did not parse');
    const result = composeAgentProfileFiles({
      manifest,
      agentName: 'support',
      behavior: { frontmatter: {}, body: 'Prompt' },
      sections: {
        skills: [
          {
            slug: 'incident-triage',
            name: 'incident-triage',
            description: 'Triage incidents.',
            origin: 'archive',
            status: 'pending_publication',
            files: [
              {
                path: '.kortix/opencode/skills/incident-triage/SKILL.md',
                content: '---\nname: incident-triage\ndescription: Triage incidents.\n---\n\nRun triage.',
              },
            ],
          },
        ],
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.files.map((file) => file.path)).toEqual([
      'kortix.yaml',
      '.kortix/opencode/agents/support.md',
      '.kortix/opencode/skills/incident-triage/SKILL.md',
    ]);
    expect(result.technicalDiff.at(-1)).toMatchObject({
      path: '.kortix/opencode/skills/incident-triage/SKILL.md',
      before: null,
    });
  });
});
