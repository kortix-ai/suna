import { describe, expect, test } from 'bun:test';

import { PAGE_TABS } from '@/stores/tab-store';

import { PROJECT_CUSTOMIZE_ITEMS } from './dock-menu';

describe('PROJECT_CUSTOMIZE_ITEMS', () => {
  test('Schedules, Secrets and Members, in that order', () => {
    expect(PROJECT_CUSTOMIZE_ITEMS.map((item) => item.label)).toEqual(['Schedules', 'Secrets', 'Members']);
  });

  test('every row opens a registered page, and no page is listed twice', () => {
    const pageIds = PROJECT_CUSTOMIZE_ITEMS.map((item) => item.pageId);
    for (const pageId of pageIds) expect(PAGE_TABS[pageId]).toBeDefined();
    expect(new Set(pageIds).size).toBe(pageIds.length);
  });

  test('webhooks are gone: the page is deleted and no row opens it', () => {
    // Jay, 2026-09-22 — the mobile webhooks page was removed. Webhook
    // TRIGGERS stay; they live on the Schedules page.
    const pageIds = PROJECT_CUSTOMIZE_ITEMS.map((item) => item.pageId);
    expect(pageIds).not.toContain('page:webhooks');
    expect(PAGE_TABS['page:webhooks']).toBeUndefined();
  });

  test('members is an in-app page again (Jay, 2026-09-24): its row opens page:members', () => {
    const members = PROJECT_CUSTOMIZE_ITEMS.find((item) => item.label === 'Members');
    expect(members?.pageId).toBe('page:members');
    expect(PAGE_TABS['page:members']).toEqual({ id: 'page:members', label: 'Members' });
  });

  test('terminal, agents and skills have no mobile page (COR-160): no row opens any of them', () => {
    const pageIds = PROJECT_CUSTOMIZE_ITEMS.map((item) => item.pageId);
    expect(pageIds).not.toContain('page:terminal');
    expect(pageIds).not.toContain('page:agents');
    expect(pageIds).not.toContain('page:skills');
    expect(PAGE_TABS['page:terminal']).toBeUndefined();
    expect(PAGE_TABS['page:agents']).toBeUndefined();
    expect(PAGE_TABS['page:skills']).toBeUndefined();
  });

  test('files stay reachable from the drawer only: no row here opens them', () => {
    const pageIds = PROJECT_CUSTOMIZE_ITEMS.map((item) => item.pageId);
    expect(pageIds).not.toContain('page:files-nav');
    expect(pageIds).not.toContain('page:files');
  });

  test('models have no row: mobile has no models screen', () => {
    const pageIds = PROJECT_CUSTOMIZE_ITEMS.map((item) => item.pageId);
    expect(pageIds).not.toContain('page:llm-providers');
  });

  test('commands are deprecated: the page is gone and no row opens it', () => {
    const pageIds = PROJECT_CUSTOMIZE_ITEMS.map((item) => item.pageId);
    expect(pageIds).not.toContain('page:commands');
    expect(PAGE_TABS['page:commands']).toBeUndefined();
  });

  test('the laptop guide ("Develop on your own machine") has no row on a phone', () => {
    const pageIds = PROJECT_CUSTOMIZE_ITEMS.map((item) => item.pageId);
    expect(pageIds).not.toContain('page:dev');
  });

  test('connectors are web-only: no row opens the connectors page', () => {
    const pageIds = PROJECT_CUSTOMIZE_ITEMS.map((item) => item.pageId);
    expect(pageIds).not.toContain('page:connectors');
  });
});
