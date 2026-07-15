import { beforeEach, describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { useKortixComputerStore } from '@/stores/kortix-computer-store';
import { SessionReadyChip } from './session-ready-chip';

describe('SessionReadyChip', () => {
  beforeEach(() => {
    useKortixComputerStore.getState().reset();
  });

  test('renders nothing without a chip, or for another session', () => {
    expect(renderToStaticMarkup(<SessionReadyChip sessionId="s1" />)).toBe('');
    useKortixComputerStore.getState().setReadyChip({ sessionId: 'other', outcome: 'ready', count: 1 });
    expect(renderToStaticMarkup(<SessionReadyChip sessionId="s1" />)).toBe('');
  });

  test('ready chip leads with the primary deliverable name', () => {
    useKortixComputerStore
      .getState()
      .setReadyChip({ sessionId: 's1', outcome: 'ready', count: 3, primaryName: 'Quarterly report' });
    const html = renderToStaticMarkup(<SessionReadyChip sessionId="s1" />);
    expect(html).toContain('Quarterly report is ready');
    expect(html).toContain('View');
  });

  test('multiple deliverables with no primary name count them', () => {
    useKortixComputerStore.getState().setReadyChip({ sessionId: 's1', outcome: 'ready', count: 3 });
    expect(renderToStaticMarkup(<SessionReadyChip sessionId="s1" />)).toContain('3 results ready');
  });

  // ─── MINOR SWEEP (d) — "files" undersold a run whose deliverables aren't
  // all files (a live app, a deck); "results" covers every kind. ──
  test('a single deliverable with no primary name uses the singular', () => {
    useKortixComputerStore.getState().setReadyChip({ sessionId: 's1', outcome: 'ready', count: 1 });
    expect(renderToStaticMarkup(<SessionReadyChip sessionId="s1" />)).toContain('1 result ready');
  });

  test('failed, stopped, and needs-input variants say what happened', () => {
    const store = useKortixComputerStore.getState();
    store.setReadyChip({ sessionId: 's1', outcome: 'stopped', count: 0 });
    expect(renderToStaticMarkup(<SessionReadyChip sessionId="s1" />)).toContain('Stopped before finishing');
    store.setReadyChip({ sessionId: 's1', outcome: 'failed', count: 0 });
    expect(renderToStaticMarkup(<SessionReadyChip sessionId="s1" />)).toContain('Something went wrong');
    store.setReadyChip({ sessionId: 's1', outcome: 'needs_input', count: 0 });
    expect(renderToStaticMarkup(<SessionReadyChip sessionId="s1" />)).toContain('Needs your input');
  });
});
