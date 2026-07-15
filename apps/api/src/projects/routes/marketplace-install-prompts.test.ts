import { describe, expect, test } from 'bun:test';

import { buildTemplateInstallPrompt } from './marketplace-install-prompts';

function templateEntry(over: Record<string, unknown> = {}) {
  return {
    item: {
      name: 'customer-support',
      type: 'registry:template',
      title: 'Customer support on autopilot',
      description: 'Works the Plain support queue.',
      registryDependencies: ['support-agent'],
      envVars: { PLAIN_API_KEY: 'Plain key', STRIPE_SECRET_KEY: 'Stripe key' },
      inputs: [
        { key: 'cadence', label: 'How often to check', type: 'cron', default: '0 */15 * * * *', required: true },
      ],
      meta: {
        template: {
          agents: { 'support-agent': { secrets: ['PLAIN_API_KEY', 'STRIPE_SECRET_KEY'] } },
          triggers: [
            { slug: 'support-triage', type: 'cron', agent: 'support-agent', cron: '{{cadence}}', prompt: 'Check Plain.' },
          ],
          env_optional: ['PLAIN_API_KEY', 'STRIPE_SECRET_KEY'],
        },
      },
      ...over,
    },
  } as unknown as Parameters<typeof buildTemplateInstallPrompt>[0];
}

describe('buildTemplateInstallPrompt', () => {
  test('tells the agent to read the template via its marketplace CLI', () => {
    const p = buildTemplateInstallPrompt(templateEntry(), 'kortix-starter:customer-support');
    expect(p).toContain('Customer support on autopilot');
    expect(p).toContain('kortix marketplace show kortix-starter:customer-support');
  });

  test('gives dependency parts as fully-qualified ids so nothing is searched for', () => {
    const p = buildTemplateInstallPrompt(templateEntry(), 'kortix-starter:customer-support');
    // namespaced from the template id, not a bare "support-agent"
    expect(p).toContain('kortix-starter:support-agent');
    expect(p).toContain('through the marketplace');
  });

  test('wires the trigger from meta.template and ships it DISABLED', () => {
    const p = buildTemplateInstallPrompt(templateEntry(), 'kortix-starter:customer-support');
    expect(p).toContain('meta.template.triggers');
    expect(p).toContain('{{key}}');
    expect(p).toContain('enabled: false');
    expect(p).toContain('DISABLED');
  });

  test('walks the required secrets and holds the run behind a confirmation', () => {
    const p = buildTemplateInstallPrompt(templateEntry(), 'kortix-starter:customer-support');
    expect(p).toContain('PLAIN_API_KEY');
    expect(p).toContain('STRIPE_SECRET_KEY');
    expect(p).toContain('never ask me to paste a raw key');
    expect(p).toContain("don't run anything until I say go");
  });

  test('handles a template with no dependencies without erroring', () => {
    const p = buildTemplateInstallPrompt(templateEntry({ registryDependencies: [] }), 'kortix-starter:x');
    expect(p).toContain('kortix marketplace show kortix-starter:x');
    expect(p).not.toContain('Install its parts');
  });
});
