import { describe, expect, test } from 'bun:test';

import { installSessionPrompt } from './template-session-install-dialog';

function detail(over: Record<string, unknown> = {}) {
  return {
    id: 'dependency-upgrades',
    title: 'Dependency upgrades on autopilot',
    description: null,
    inputs: [],
    requirements: [],
    installs: [],
    connectors: [],
    secrets: [],
    ...over,
  } as Parameters<typeof installSessionPrompt>[0];
}

describe('installSessionPrompt', () => {
  test('references the template id and title so the agent installs the right thing', () => {
    const p = installSessionPrompt(detail());
    expect(p).toContain('dependency-upgrades');
    expect(p).toContain('Dependency upgrades on autopilot');
  });

  test('installs through the marketplace with inputs and the trigger disabled', () => {
    const p = installSessionPrompt(detail());
    expect(p).toContain('kortix marketplace install dependency-upgrades');
    expect(p).toContain('--input');
    expect(p.toUpperCase()).toContain('DISABLED');
  });

  test('keeps secrets out of the chat and holds the run behind a confirmation', () => {
    const p = installSessionPrompt(detail()).toLowerCase();
    expect(p).toContain('never ask me to paste a secret');
    expect(p).toContain("don't run anything until i say go");
  });

  test('escapes the id into the prompt for any template id', () => {
    const p = installSessionPrompt(detail({ id: 'customer-support', title: 'Customer support' }));
    expect(p).toContain('kortix marketplace show customer-support');
    expect(p).toContain('customer-support');
  });
});
