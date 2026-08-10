/**
 * The finish step is the payoff for the two survey screens. If it renders a
 * generic "you're all set" it has taken two screens of the user's attention and
 * given nothing back.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(join(import.meta.dir, 'steps', 'done-step.tsx'), 'utf8');
const shell = readFileSync(join(import.meta.dir, '..', 'workspace-onboarding-wizard.tsx'), 'utf8');

describe('done step', () => {
  test('derives its prompts from the survey answer', () => {
    expect(source).toContain('starterPromptsFor');
  });

  test('renders prompts as the shared row primitive', () => {
    expect(source).toContain('<ActionRow');
  });

  test('stays inside the column — nothing full-bleed', () => {
    expect(source).not.toContain('vh]');
  });

  // "…with 0 tools connected" is worse than saying nothing.
  test('omits the tool-count clause when nothing is connected', () => {
    expect(source).toContain('profileCount > 0');
  });
});

describe('prompt handoff', () => {
  // The store's own docstring names the onboarding wizard as an intended
  // caller, and workspace-home.tsx consumes it on mount. No new store invented.
  test('seeds the existing project composer prefill store', () => {
    expect(shell).toContain('useComposerPrefillStore');
    expect(shell).toContain('setPrefill(workspaceId,');
  });

  // A prefill that outlives the wizard would reappear on an unrelated visit;
  // the store's `consume` clears it, but only if onboarding actually completes.
  test('completes onboarding in the same action that seeds the prompt', () => {
    expect(shell).toContain('onUsePrompt');
    expect(shell).toContain('complete()');
  });
});
