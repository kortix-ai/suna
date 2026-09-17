/**
 * The finish step hands the person to their project's first chat: a welcome
 * and an idle composer. It no longer sends a message on their behalf.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(join(import.meta.dir, 'steps', 'done-step.tsx'), 'utf8');
const shell = readFileSync(join(import.meta.dir, '..', 'project-onboarding-wizard.tsx'), 'utf8');
const prefillStore = readFileSync(
  join(import.meta.dir, '..', '..', '..', 'stores', 'composer-prefill-store.ts'),
  'utf8',
);

describe('done step', () => {
  test('has no starter-tile picker', () => {
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

  test('opens the project on the done step primary action', () => {
    expect(source).toContain('onPrimary={onStart}');
    expect(shell).toContain('onStart={openProject}');
  });
});

describe('first chat hand-off', () => {
  // Both ways out of the wizard land on the first chat, so a person who skips
  // gets the same calm start as a person who finishes.
  test('finishing and skipping both start the first chat before completing', () => {
    const openProject = shell.slice(
      shell.indexOf('const openProject = useCallback'),
      shell.indexOf('const skipSurvey'),
    );
    expect(openProject).toContain('useFirstChatStore.getState().start(projectId)');
    expect(openProject).toContain('complete()');

    const skip = shell.slice(
      shell.indexOf('const skip = useCallback'),
      shell.indexOf('const openProject = useCallback'),
    );
    expect(skip).toContain('useFirstChatStore.getState().start(projectId)');
    expect(skip).toContain('onboarding.complete()');
  });

  // The regression this ticket removes: a turn the person never asked for.
  test('nothing in the hand-off sends a message', () => {
    expect(shell).not.toContain('setPrefill(');
    expect(prefillStore).not.toContain('autoSend');
  });
});
