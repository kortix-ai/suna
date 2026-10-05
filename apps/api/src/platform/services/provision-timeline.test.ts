// Unit tests for ProvisionTimeline itself. Surfacing a timeline on the wire
// (the turn-latency spec (PR #7840) §5) is covered separately by
// `lib/server-timing.test.ts` (`recordTurnStageMarks`/`formatTurnStageEntries`)
// — see the module doc at the bottom of provision-timeline.ts for why that
// lives there instead of a second header mechanism here.
import { describe, expect, spyOn, test } from 'bun:test';
import { ProvisionTimeline } from './provision-timeline';
import { parseTimelineLine } from '../../../scripts/prompt-latency-bench';

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

  test('a parallel-branch note never moves the sequential cursor', async () => {
    const ptl = new ProvisionTimeline('sandbox-3', 'provision');
    ptl.mark('row+tokens');
    await Bun.sleep(15);
    ptl.note('image:resolved');
    ptl.mark('image-cached');
    const [row, note, image] = ptl.summary().marks;
    expect(note?.deltaMs).toBe(note?.atMs); // measured from the start, not from row+tokens
    // The main path's delta still spans everything since row+tokens.
    expect(image!.deltaMs).toBeGreaterThanOrEqual(image!.atMs - row!.atMs - 1);
    expect(image!.deltaMs).toBeGreaterThanOrEqual(14);
  });

  test('log() returns the same summary it prints', () => {
    const ptl = new ProvisionTimeline('sandbox-2', 'proxy');
    ptl.mark('turn-begin');
    const summary = ptl.log();
    expect(summary.marks).toHaveLength(1);
    expect(summary.marks[0]?.label).toBe('turn-begin');
  });

  test('the latency bench parses the line log() prints', () => {
    const print = spyOn(console, 'log').mockImplementation(() => {});
    const tl = new ProvisionTimeline('0123456789abcdef', 'deliver');
    tl.mark('admit');
    tl.mark('open-session:ready');
    const summary = tl.log({ outcome: 'delivered' });
    const line = String(print.mock.calls[0]?.[0]);
    print.mockRestore();
    expect(parseTimelineLine(line)).toEqual({
      kind: 'deliver',
      id: '01234567',
      total: summary.totalMs,
      marks: { admit: summary.marks[0]!.deltaMs, 'open-session:ready': summary.marks[1]!.deltaMs },
    });
  });
});
