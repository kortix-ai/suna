import { expect, test } from 'bun:test';
import { activityText, fieldLabel } from '../../src/lib/run-activity';

test('engine steps read as lawyer-facing progress; other text passes', () => {
  expect(activityText('Checking the agent kit')).toBe('Getting the legal agents ready');
  expect(activityText('Agent kit 1.1.4')).toBe('Legal agents ready');
  expect(activityText('Batch 1: starting a workspace')).toBe('Batch 1: starting');
  expect(activityText('Batch 1: asked the agent to fix 10 problems')).toBe('Batch 1: 10 results sent back for correction');
  expect(activityText('Report: asked the agent to fix 1 problem')).toBe('Report: 1 result sent back for correction');
  expect(activityText('Batch 2 done')).toBe('Batch 2 done');
  expect(fieldLabel('governing_law')).toBe('Governing law');
});
