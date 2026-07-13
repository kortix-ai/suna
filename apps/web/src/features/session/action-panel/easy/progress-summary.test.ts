import { describe, expect, it } from 'bun:test';
import type { Step } from '../shared/group-steps';
import { formatDuration, progressSubtitle, summarizeSteps } from './progress-summary';

function step(overrides: Partial<Step> = {}): Step {
  return {
    id: `c-${Math.random()}`,
    family: 'explore',
    label: 'Read 3 files',
    parts: [],
    status: 'done',
    ...overrides,
  };
}

describe('formatDuration', () => {
  it('renders sub-minute durations as seconds', () => {
    expect(formatDuration(42_000)).toBe('42s');
  });

  it('rounds to the nearest second', () => {
    expect(formatDuration(41_600)).toBe('42s');
  });

  it('pads seconds to two digits once minutes appear', () => {
    expect(formatDuration(64_000)).toBe('1m 04s');
  });

  it('does not pad the minutes part itself', () => {
    expect(formatDuration(12 * 60_000 + 5_000)).toBe('12m 05s');
  });

  it('treats zero as zero seconds, not a blank string', () => {
    expect(formatDuration(0)).toBe('0s');
  });
});

describe('summarizeSteps', () => {
  it('uses singular "step" for exactly one', () => {
    expect(summarizeSteps([step()])).toBe('1 step');
  });

  it('uses plural "steps" for zero or many', () => {
    expect(summarizeSteps([])).toBe('0 steps');
    expect(summarizeSteps([step(), step()])).toBe('2 steps');
  });

  it('omits the duration when no step carries timing', () => {
    expect(summarizeSteps([step(), step()])).toBe('2 steps');
  });

  it('appends the total duration across all steps when timed', () => {
    const steps = [step({ durationMs: 30_000 }), step({ durationMs: 34_000 })];
    expect(summarizeSteps(steps)).toBe('2 steps · 1m 04s');
  });

  it('ignores steps with no durationMs when summing', () => {
    const steps = [step({ durationMs: undefined }), step({ durationMs: 5_000 })];
    expect(summarizeSteps(steps)).toBe('2 steps · 5s');
  });
});

describe('progressSubtitle', () => {
  it('is calm and true when idle with no steps at all', () => {
    expect(progressSubtitle([], false)).toBe('Nothing to show yet');
  });

  it('is calm but alive when running with no steps yet', () => {
    expect(progressSubtitle([], true)).toBe('Just getting started');
  });

  it('surfaces the current (last) step label verbatim while running', () => {
    const steps = [step({ label: 'Read 3 files' }), step({ label: 'Ran a command' })];
    expect(progressSubtitle(steps, true)).toBe('Ran a command');
  });

  it('never rewrites or post-processes the step label', () => {
    const weird = 'Read 3 files (label owns its own punctuation!)';
    expect(progressSubtitle([step({ label: weird })], true)).toBe(weird);
  });

  it('settles into the summary once idle', () => {
    const steps = [step({ durationMs: 12_000 }), step({ durationMs: 52_000 })];
    expect(progressSubtitle(steps, false)).toBe('2 steps · 1m 04s');
  });
});
