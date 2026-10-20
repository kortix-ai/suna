import { describe, expect, test } from 'bun:test';

import { normalizeCaptureAppId, normalizeCaptureDomain } from '@kortix/sdk';

import {
  CAPTURE_APP_CATALOG,
  CAPTURE_SITE_CATALOG,
  catalogApp,
  catalogSuggestions,
  namedAppRows,
  siteSuggestions,
} from './capture-app-catalog';
import groupsCopy from './exclusion-groups.json';

describe('capture app catalog', () => {
  test('every catalog id and site passes the policy rules unchanged', () => {
    for (const app of CAPTURE_APP_CATALOG)
      for (const id of app.ids) expect(normalizeCaptureAppId(id)).toBe(id);
    for (const site of CAPTURE_SITE_CATALOG) expect(normalizeCaptureDomain(site)).toBe(site);
  });

  test('ids of one app show as one named row; unknown ids keep their own row', () => {
    const rows = namedAppRows([
      { id: 'com.tinyspeck.slackmacgap', locked: false },
      { id: 'other.app', locked: false },
      { id: 'SLACK.EXE', locked: true },
    ]);
    expect(rows).toEqual([
      {
        ids: ['com.tinyspeck.slackmacgap', 'SLACK.EXE'],
        name: 'Slack',
        detail: 'com.tinyspeck.slackmacgap, SLACK.EXE',
        locked: true,
      },
      { ids: ['other.app'], name: 'other.app', detail: '', locked: false },
    ]);
  });

  test('suggestions leave out what is fully added and match by name', () => {
    const all = CAPTURE_APP_CATALOG.flatMap((a) => (a.name === 'Slack' ? a.ids : []));
    expect(catalogSuggestions(all, '').some((a) => a.name === 'Slack')).toBe(false);
    expect(catalogSuggestions([], 'sla').map((a) => a.name)).toEqual(['Slack']);
    expect(siteSuggestions(['github.com'], 'git')).toEqual([]);
    expect(siteSuggestions([], 'linear')).toEqual(['linear.app']);
  });

  test('every app of every category has a name', () => {
    const unnamed = groupsCopy.groups.flatMap((g) => g.apps.filter((id) => !catalogApp(id)));
    expect(unnamed).toEqual([]);
  });

  test('apps outside the common list are offered only when searched by name', () => {
    expect(catalogSuggestions([], '').some((a) => a.name === '1Password' || a.name === 'AutoCAD')).toBe(false);
    expect(catalogSuggestions([], '1pass').map((a) => a.name)).toEqual(['1Password']);
    expect(catalogSuggestions([], 'autocad').map((a) => a.ids)).toEqual([
      ['acad.exe', 'acadlt.exe', 'com.autodesk.autocad*', 'autocad*'],
    ]);
  });
});
