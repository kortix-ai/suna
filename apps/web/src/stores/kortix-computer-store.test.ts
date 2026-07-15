import { beforeEach, describe, expect, test } from 'bun:test';
import { useKortixComputerStore } from './kortix-computer-store';

describe('ready chip state (W1)', () => {
  beforeEach(() => {
    useKortixComputerStore.getState().reset();
  });

  test('set → read → clear', () => {
    const s = useKortixComputerStore.getState();
    s.setReadyChip({ sessionId: 's1', outcome: 'ready', count: 3, primaryName: 'Quarterly report' });
    expect(useKortixComputerStore.getState().readyChip?.primaryName).toBe('Quarterly report');
    useKortixComputerStore.getState().clearReadyChip();
    expect(useKortixComputerStore.getState().readyChip).toBeNull();
  });

  test('opening the panel clears the chip — a seen panel needs no announcement', () => {
    const s = useKortixComputerStore.getState();
    s.setReadyChip({ sessionId: 's1', outcome: 'ready', count: 1 });
    s.setIsSidePanelOpen(true);
    expect(useKortixComputerStore.getState().readyChip).toBeNull();
  });

  test('primary-open request is one-shot and session-scoped', () => {
    const s = useKortixComputerStore.getState();
    s.requestPrimaryOpen('s1');
    expect(useKortixComputerStore.getState().consumePrimaryOpen('other')).toBe(false);
    expect(useKortixComputerStore.getState().consumePrimaryOpen('s1')).toBe(true);
    expect(useKortixComputerStore.getState().consumePrimaryOpen('s1')).toBe(false);
  });
});
