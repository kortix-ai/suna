import { describe, expect, test } from 'bun:test';
import { PANEL_EVENTS, type PanelEvent } from './track';

describe('track event registry (W5)', () => {
  test('every spec W5 event and genui_block exists exactly once', () => {
    const expected: PanelEvent[] = [
      'panel_opened',
      'ready_chip_shown',
      'ready_chip_clicked',
      'deliverable_opened',
      'deliverable_downloaded',
      'deliverable_link_copied',
      'app_send_to_agent_clicked',
      'present_opened',
      'app_opened_new_tab',
      'image_copied',
      'panel_mode_switched',
      'conversation_density_switched',
      // Generative UI block settle (component names, counts, outcome, timing only).
      'genui_block',
    ];
    expect([...PANEL_EVENTS].sort()).toEqual([...expected].sort());
  });
});
