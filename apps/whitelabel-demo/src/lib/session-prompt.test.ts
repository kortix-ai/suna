import { describe, expect, test } from 'bun:test';
import { buildSessionPrompt } from './session-prompt';

describe('buildSessionPrompt', () => {
  test('anchors a generic white-label request to the Kortix workspace execution model', () => {
    const prompt = buildSessionPrompt({
      prompt: 'Add a README section and explain the changes.',
      mode: 'Build',
    });

    expect(prompt).toContain('default agent');
    expect(prompt).toContain('Kortix/Suna workspace');
    expect(prompt).toContain('Mode: Build');
    expect(prompt).toContain('Add a README section');
    expect(prompt).toContain('workspace artifacts');
    expect(prompt).toContain('backend source of truth');
  });
});
