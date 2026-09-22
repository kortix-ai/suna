import { describe, expect, test } from 'bun:test';

import { PAGE_TABS } from '@/stores/tab-store';

import { CUSTOMIZE_SHEET_GROUPS } from './dock-menu';

describe('CUSTOMIZE_SHEET_GROUPS', () => {
  test('the first group is the five core sections, in order, with no title', () => {
    const [core] = CUSTOMIZE_SHEET_GROUPS;
    expect(core.title).toBeNull();
    expect(core.items.map((item) => item.label)).toEqual([
      'Agents',
      'Skills',
      'Schedules',
      'Review',
      'Secrets',
    ]);
  });

  test('the second group keeps every other page that was reachable', () => {
    const [, more] = CUSTOMIZE_SHEET_GROUPS;
    expect(CUSTOMIZE_SHEET_GROUPS).toHaveLength(2);
    expect(more.title).toBe('More');
    expect(more.items.map((item) => item.label)).toEqual([
      'Files',
      'Members',
      'Terminal',
    ]);
  });

  test('webhooks are gone: the page is deleted and no row opens it', () => {
    // Jay, 2026-09-22 — the mobile webhooks page was removed. Webhook
    // TRIGGERS stay; they live on the Schedules page.
    const pageIds = CUSTOMIZE_SHEET_GROUPS.flatMap((group) => group.items.map((item) => item.pageId));
    expect(pageIds).not.toContain('page:webhooks');
    expect(PAGE_TABS['page:webhooks']).toBeUndefined();
  });

  test('the laptop guide ("Develop on your own machine") has no row on a phone', () => {
    const pageIds = CUSTOMIZE_SHEET_GROUPS.flatMap((group) => group.items.map((item) => item.pageId));
    expect(pageIds).not.toContain('page:dev');
  });

  test('commands are deprecated: the page is gone and no row opens it', () => {
    const pageIds = CUSTOMIZE_SHEET_GROUPS.flatMap((group) => group.items.map((item) => item.pageId));
    expect(pageIds).not.toContain('page:commands');
    expect(PAGE_TABS['page:commands']).toBeUndefined();
  });

  test('connectors are web-only: no row opens the connectors page', () => {
    const pageIds = CUSTOMIZE_SHEET_GROUPS.flatMap((group) => group.items.map((item) => item.pageId));
    expect(pageIds).not.toContain('page:connectors');
  });

  test('every row opens a registered page, and no page is listed twice', () => {
    const pageIds = CUSTOMIZE_SHEET_GROUPS.flatMap((group) => group.items.map((item) => item.pageId));
    for (const pageId of pageIds) expect(PAGE_TABS[pageId]).toBeDefined();
    expect(new Set(pageIds).size).toBe(pageIds.length);
  });
});
