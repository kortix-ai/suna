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
  test('names the template, its id, and asks for each declared input with defaults', () => {
    const p = buildTemplateInstallPrompt(templateEntry(), 'kortix-starter:customer-support');
    expect(p).toContain('Customer support on autopilot');
    expect(p).toContain('kortix-starter:customer-support');
    expect(p).toContain('cadence');
    expect(p).toContain('0 */15 * * * *');
  });

  test('embeds the trigger + agent grant to wire, shipping it DISABLED', () => {
    const p = buildTemplateInstallPrompt(templateEntry(), 'kortix-starter:customer-support');
    expect(p).toContain('support-triage');
    expect(p).toContain('{{cadence}}');
    expect(p).toContain('enabled: false');
    expect(p).toContain('DISABLED');
  });

  test('walks through the required secrets and holds the run behind a confirmation', () => {
    const p = buildTemplateInstallPrompt(templateEntry(), 'kortix-starter:customer-support');
    expect(p).toContain('PLAIN_API_KEY');
    expect(p).toContain('STRIPE_SECRET_KEY');
    expect(p).toContain('never ask me to paste a raw key');
    expect(p).toContain("don't run anything until I say go");
  });

  test('lists the parts to install from registryDependencies when no files are inlined', () => {
    const p = buildTemplateInstallPrompt(templateEntry(), 'kortix-starter:customer-support');
    expect(p).toContain('support-agent');
  });

  test('inlines resolved dependency file content (resolved path + body) so nothing is fetched', () => {
    const p = buildTemplateInstallPrompt(templateEntry(), 'kortix-starter:customer-support', [
      { path: '@agents/support-agent.md', content: 'You are the support agent for {{projectName}}.' },
      { path: '@skills/support-playbook/SKILL.md', content: '# playbook' },
    ]);
    expect(p).toContain('.kortix/opencode/agents/support-agent.md');
    expect(p).toContain('You are the support agent for {{projectName}}.');
    expect(p).toContain('.kortix/opencode/skills/support-playbook/SKILL.md');
    expect(p).not.toContain("fetch each one's source");
  });

  test('handles a template with no inputs without erroring', () => {
    const p = buildTemplateInstallPrompt(templateEntry({ inputs: [] }), 'kortix-starter:x');
    expect(p).toContain('no inputs to collect');
  });
});
