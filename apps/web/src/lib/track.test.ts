import { describe, expect, test } from 'bun:test';
import { PANEL_EVENTS, type PanelEvent } from './track';

// The registry is a CLOSED set on purpose: `track` is the one funnel into
// posthog, so an event that is not listed here cannot be sent, and the no-PII
// rule has a single place to be enforced. Each block below is the complete
// list for one surface; the union is asserted to be the whole registry, so a
// name added to `track.ts` without being claimed by a surface fails here.
const W5_EVENTS: PanelEvent[] = [
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
];

const QUEUE_EVENTS: PanelEvent[] = [
  'queue_item_added',
  'queue_item_edited',
  'queue_item_deleted',
  'queue_item_reordered',
  'queue_item_dispatched',
  'queue_paused',
  'queue_cleared',
  'queue_double_send_prevented',
];

describe('track event registry (W5)', () => {
  test('every spec W5 event exists exactly once', () => {
    for (const event of W5_EVENTS) {
      expect(PANEL_EVENTS.filter((name) => name === event)).toEqual([event]);
    }
  });

  test('every queue event exists exactly once', () => {
    for (const event of QUEUE_EVENTS) {
      expect(PANEL_EVENTS.filter((name) => name === event)).toEqual([event]);
    }
  });

  test('the registry is exactly those surfaces — nothing unclaimed', () => {
    expect([...PANEL_EVENTS].sort()).toEqual([...W5_EVENTS, ...QUEUE_EVENTS].sort());
  });
});
