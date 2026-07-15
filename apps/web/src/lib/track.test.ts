import { describe, expect, test } from 'bun:test';
import { PANEL_EVENTS, type PanelEvent } from './track';

describe('track event registry (W5)', () => {
  test('every spec W5 event exists exactly once', () => {
    const expected: PanelEvent[] = [
      'panel_opened',
      'ready_chip_shown',
      'ready_chip_clicked',
      'deliverable_opened',
      'deliverable_downloaded',
      'ask_for_changes_clicked',
      'present_opened',
      'app_opened_new_tab',
      'app_link_copied',
      'image_copied',
      'panel_mode_switched',
    ];
    expect([...PANEL_EVENTS].sort()).toEqual([...expected].sort());
  });
});
