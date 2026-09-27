// Unit tests for ProvisionTimeline itself. Surfacing a timeline on the wire
// (the turn-latency spec (PR #7840) §5) is covered separately by
// `lib/server-timing.test.ts` (`recordTurnStageMarks`/`formatTurnStageEntries`)
// — see the module doc at the bottom of provision-timeline.ts for why that
// lives there instead of a second header mechanism here.
import { describe, expect, test } from 'bun:test';
import { ProvisionTimeline } from './provision-timeline';

describe('ProvisionTimeline', () => {
  test('records marks in order with cumulative and delta timing', () => {
    const ptl = new ProvisionTimeline('sandbox-1', 'proxy');
    ptl.mark('load-sandbox');
    ptl.mark('ingress');
    const summary = ptl.summary();
    expect(summary.id).toBe('sandbox-1');
    expect(summary.kind).toBe('proxy');
    expect(summary.marks.map((m) => m.label)).toEqual(['load-sandbox', 'ingress']);
    expect(summary.totalMs).toBeGreaterThanOrEqual(0);
    for (const mark of summary.marks) {
      expect(mark.atMs).toBeGreaterThanOrEqual(0);
      expect(mark.deltaMs).toBeGreaterThanOrEqual(0);
    }
  });

  test('log() returns the same summary it prints', () => {
    const ptl = new ProvisionTimeline('sandbox-2', 'proxy');
    ptl.mark('turn-begin');
    const summary = ptl.log();
    expect(summary.marks).toHaveLength(1);
    expect(summary.marks[0]?.label).toBe('turn-begin');
  });
});
