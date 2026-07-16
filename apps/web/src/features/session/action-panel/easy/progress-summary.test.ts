import { describe, expect, it } from 'bun:test';
import { formatDuration } from './progress-summary';

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


