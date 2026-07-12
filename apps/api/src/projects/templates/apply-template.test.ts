import { describe, expect, test } from 'bun:test';
import { parseManifestText } from '@kortix/manifest-schema';

import {
  buildTemplateInstall,
  parseTemplateBlock,
  renderInputs,
  resolveInputValues,
  type BuildTemplateInstallInput,
} from './apply-template';

function template() {
  return {
    name: 'ar-chaser',
    type: 'registry:template',
    title: 'AR chaser',
    inputs: [
      { key: 'cadence', label: 'Cadence', type: 'cron', default: '0 0 9 * * 1-5' },
      { key: 'alert_channel', label: 'Alert channel', type: 'channel' },
    ],
    meta: {
      template: {
        agents: { 'ar-chaser': { connectors: ['stripe', 'slack'], secrets: ['STRIPE_KEY'] } },
        connectors: [
          { slug: 'stripe', provider: 'pipedream' },
          { slug: 'slack', provider: 'pipedream' },
        ],
        triggers: [
          {
            slug: 'daily-check',
            name: 'Daily check',
            type: 'cron',
            agent: 'ar-chaser',
            cron: '{{cadence}}',
            session_mode: 'reuse',
            prompt: 'Chase overdue invoices, post the list to {{alert_channel}}.',
          },
        ],
      },
    },
  } as unknown as BuildTemplateInstallInput['template'];
}

function input(over: Partial<BuildTemplateInstallInput> = {}): BuildTemplateInstallInput {
  const t = template();
  return {
    template: t,
    block: parseTemplateBlock(t),
    registryFiles: [
      { path: '.kortix/opencode/agents/ar-chaser.md', content: 'Posts to {{alert_channel}}.' },
      { path: 'registry-lock.json', content: '{"version":2,"items":{}}' },
    ],
    capabilities: { secrets: ['STRIPE_KEY'], connectors: ['stripe', 'slack'], tools: [], network: [] },
    inputs: { alert_channel: '#finance-alerts' },
    manifestRaw: 'kortix_version: 2\nproject:\n  name: demo\n',
    manifestPath: 'kortix.yaml',
    existingConnectors: [],
    existingSecretKeys: [],
    ...over,
  };
}

function manifestOf(result: ReturnType<typeof buildTemplateInstall>) {
  const file = result.files.find((f) => f.path === 'kortix.yaml');
  if (!file) throw new Error('no manifest file');
  return parseManifestText(file.content, 'yaml');
}

describe('renderInputs', () => {
  test('substitutes known keys and blanks unknown ones', () => {
    expect(renderInputs('to {{alert_channel}} at {{cadence}}', { alert_channel: '#x' })).toBe(
      'to #x at ',
    );
  });
});

describe('resolveInputValues', () => {
  test('user values override declared defaults', () => {
    const declared = [
      { key: 'cadence', label: 'c', type: 'cron' as const, default: '0 0 9 * * 1-5' },
      { key: 'alert_channel', label: 'a', type: 'channel' as const },
    ];
    expect(resolveInputValues(declared, { alert_channel: '#ops' })).toEqual({
      cadence: '0 0 9 * * 1-5',
      alert_channel: '#ops',
    });
  });
});

describe('buildTemplateInstall', () => {
  test('renders inputs into payload files and the trigger', () => {
    const result = buildTemplateInstall(input());
    const agent = result.files.find((f) => f.path.endsWith('ar-chaser.md'));
    expect(agent?.content).toBe('Posts to #finance-alerts.');

    const m = manifestOf(result);
    const trig = (m.triggers as Record<string, unknown>[])[0];
    expect(trig.slug).toBe('daily-check');
    expect(trig.prompt).toBe('Chase overdue invoices, post the list to #finance-alerts.');
    expect(trig.cron).toBe('0 0 9 * * 1-5'); // default applied
  });

  test('ships the trigger disabled', () => {
    const m = manifestOf(buildTemplateInstall(input()));
    expect((m.triggers as Record<string, unknown>[])[0].enabled).toBe(false);
  });

  test('carries session_mode through to the trigger when the template sets it', () => {
    const m = manifestOf(buildTemplateInstall(input()));
    expect((m.triggers as Record<string, unknown>[])[0].session_mode).toBe('reuse');
  });

  test('adds new connectors and marks them new', () => {
    const result = buildTemplateInstall(input());
    const m = manifestOf(result);
    const slugs = (m.connectors as Record<string, unknown>[]).map((c) => c.slug).sort();
    expect(slugs).toEqual(['slack', 'stripe']);
    const conn = result.requirements.filter((r) => r.kind === 'connector');
    expect(conn.every((r) => r.status === 'new')).toBe(true);
  });

  test('reuses an existing connector by slug+provider instead of duplicating', () => {
    const result = buildTemplateInstall(
      input({ existingConnectors: [{ slug: 'stripe', provider: 'pipedream' }] }),
    );
    const m = manifestOf(result);
    const stripeEntries = (m.connectors as Record<string, unknown>[]).filter(
      (c) => c.slug === 'stripe',
    );
    expect(stripeEntries.length).toBe(0); // not re-added; the existing one is reused
    const stripeReq = result.requirements.find(
      (r) => r.kind === 'connector' && r.key === 'stripe',
    );
    expect(stripeReq?.status).toBe('reused');
  });

  test('namespaces a colliding trigger slug', () => {
    const result = buildTemplateInstall(
      input({
        manifestRaw:
          'kortix_version: 2\nproject:\n  name: demo\ntriggers:\n  - slug: daily-check\n    name: Existing\n    type: cron\n',
      }),
    );
    const m = manifestOf(result);
    const slugs = (m.triggers as Record<string, unknown>[]).map((t) => t.slug);
    expect(slugs).toContain('daily-check');
    expect(slugs).toContain('daily-check-2');
  });

  test('secret requirement is pending, or reused when already set', () => {
    expect(
      buildTemplateInstall(input()).requirements.find((r) => r.kind === 'secret')?.status,
    ).toBe('pending');
    expect(
      buildTemplateInstall(input({ existingSecretKeys: ['STRIPE_KEY'] })).requirements.find(
        (r) => r.kind === 'secret',
      )?.status,
    ).toBe('reused');
    const m = manifestOf(buildTemplateInstall(input()));
    expect((m.env as Record<string, unknown>).optional).toContain('STRIPE_KEY');
  });

  test('resolved input vs pending input', () => {
    const reqs = buildTemplateInstall(input()).requirements.filter((r) => r.kind === 'input');
    expect(reqs.find((r) => r.key === 'alert_channel')?.status).toBe('resolved');
    expect(reqs.find((r) => r.key === 'cadence')?.status).toBe('resolved'); // has a default
  });

  test('returns the added trigger slugs (final, namespaced) for activation', () => {
    expect(buildTemplateInstall(input()).triggerSlugs).toEqual(['daily-check']);
    const collided = buildTemplateInstall(
      input({
        manifestRaw:
          'kortix_version: 2\nproject:\n  name: demo\ntriggers:\n  - slug: daily-check\n    name: Existing\n    type: cron\n',
      }),
    );
    expect(collided.triggerSlugs).toEqual(['daily-check-2']);
  });
});
