import { describe, expect, test } from 'bun:test';
import type { App } from '@kortix/sdk';

import { browserLandingGroups } from './browser-landing';

const app = (id: string, name: string, host: string, extra: Partial<App> = {}) =>
  ({
    app_id: id,
    name,
    slug: name.toLowerCase(),
    url: `https://${host}`,
    services: [],
    active_deployment_id: 'd1',
    desired_state: 'running',
    hosting_type: 'static',
    ...extra,
  }) as unknown as App;

const crm = app('a1', 'Pipeline CRM', 'dev-crm-0123456789abcdef.apps.kortix.com');
const site = app('a2', 'Launch Site', 'dev-site-1111111111111111.apps.kortix.com');
const draft = app('a3', 'Backroom Sim', 'dev-sim-2222222222222222.apps.kortix.com', { active_deployment_id: null });

const now = new Date(2026, 9, 16, 15, 0).getTime();
const today = (h: number) => new Date(2026, 9, 16, h, 0).getTime();
const yesterday = new Date(2026, 9, 15, 12, 0).getTime();

describe('browserLandingGroups — one timeline, every App once', () => {
  const groups = browserLandingGroups(
    [crm, site, draft],
    [
      { url: 'http://localhost:3000/dashboard', visitedAt: today(10) },
      { url: `${crm.url}/deals/42`, visitedAt: today(11) },
      { url: `${crm.url}/`, visitedAt: today(9) },
      { url: site.url, visitedAt: yesterday },
    ],
    now,
  );

  test('Today holds today’s visits, newest first; an App collapses to its latest visit', () => {
    expect(groups.today.map((row) => row.label)).toEqual(['Pipeline CRM', 'localhost:3000/dashboard']);
    expect(groups.today[0]!.url).toBe(`${crm.url}/deals/42`);
  });

  test('Earlier holds older visits', () => {
    expect(groups.earlier.map((row) => row.label)).toEqual(['Launch Site']);
  });

  test('Not opened yet holds every App with no visit, and no App appears twice', () => {
    expect(groups.notOpened.map((row) => row.label)).toEqual(['Backroom Sim']);
    expect(groups.notOpened[0]!.thumb).toBe('app-draft');
    const all = [...groups.today, ...groups.earlier, ...groups.notOpened].map((row) => row.key);
    expect(new Set(all).size).toBe(all.length);
  });

  test('a port is set in mono; an App by its name', () => {
    expect(groups.today[1]!.mono).toBe(true);
    expect(groups.today[0]!.mono).toBe(false);
  });

  test('no Apps and no recents: three empty groups', () => {
    expect(browserLandingGroups([], [], now)).toEqual({ today: [], earlier: [], notOpened: [] });
  });
});
