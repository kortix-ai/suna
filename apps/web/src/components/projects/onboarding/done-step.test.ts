/**
 * The finish step is the payoff for the two survey screens. "Open project"
 * now auto-starts the first conversation using what the survey actually
 * collected, instead of handing the user a picker of generic starter tiles.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(join(import.meta.dir, 'steps', 'done-step.tsx'), 'utf8');
const shell = readFileSync(join(import.meta.dir, '..', 'project-onboarding-wizard.tsx'), 'utf8');

describe('done step', () => {
  test('previews the exact message it is about to auto-send', () => {
    expect(source).toContain('buildOnboardingKickoffPrompt');
  });

  test('has no starter-tile picker — one real opener beats three generic ones', () => {
    expect(source).not.toContain('starterPromptsFor');
    expect(source).not.toContain('<ActionRow');
    expect(source).not.toContain('onUsePrompt');
  });

  test('stays inside the column — nothing full-bleed', () => {
    expect(source).not.toContain('vh]');
  });

  // "…with 0 tools connected" is worse than saying nothing.
  test('omits the tool-count clause when nothing is connected', () => {
    expect(source).toContain('connectedCount > 0');
  });
});

describe('prompt handoff', () => {
  // The store's own docstring names the onboarding wizard as an intended
  // caller, and project-home.tsx consumes it on mount. No new store invented.
  test('seeds the existing project composer prefill store', () => {
    expect(shell).toContain('useComposerPrefillStore');
    expect(shell).toContain('setPrefill(projectId,');
  });

  // "Open project" is the one explicit action the user takes — it both
  // stamps onboarding complete and asks project-home to auto-send the
  // kickoff prompt as the session's first turn.
  test('auto-sends the kickoff prompt rather than just prefilling the box', () => {
    expect(shell).toContain('buildOnboardingKickoffPrompt');
    expect(shell).toContain('{ autoSend: true }');
  });

  // A prefill that outlives the wizard would reappear on an unrelated visit;
  // the store's `consume` clears it, but only if onboarding actually completes.
  test('completes onboarding in the same action that seeds the prompt', () => {
    expect(shell).toContain('openProject');
    expect(shell).toContain('complete()');
  });
});
