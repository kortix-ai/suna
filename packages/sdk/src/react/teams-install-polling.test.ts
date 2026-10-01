import { describe, expect, test } from 'bun:test';
import { teamsInstallRefetchInterval } from './teams-install-polling';
import type { TeamsInstallation } from './use-teams-installations';

const base: TeamsInstallation = {
  tenantId: '36009a52-46d2-44bc-ba56-57a87e485e0a',
  teamId: null,
  teamName: null,
  botId: null,
  serviceUrl: null,
  byo: false,
  orgInstalled: false,
  catalogAppId: null,
  publishState: null,
  publishError: null,
  installedAt: '2026-09-17T10:00:00.000Z',
};

/**
 * The one-click Teams install finishes its org-catalog publish in the
 * background (the API redirects `?teams=publishing` after 8 s). The install
 * query must poll while that is in flight and stop the moment it settles —
 * otherwise the row shows "publishing…" forever or every project page polls
 * the installation endpoint for no reason.
 */
describe('teamsInstallRefetchInterval', () => {
  test('polls every 3 s while the catalog publish is in flight', () => {
    expect(teamsInstallRefetchInterval({ ...base, publishState: 'publishing' })).toBe(3000);
  });

  test('stops once the publish settled, whatever the outcome', () => {
    for (const publishState of ['published', 'review', 'failed'] as const) {
      expect(teamsInstallRefetchInterval({ ...base, publishState })).toBe(false);
    }
  });

  test('does not poll a manual/BYO install (no publish ever ran) or a missing install', () => {
    expect(teamsInstallRefetchInterval(base)).toBe(false);
    expect(teamsInstallRefetchInterval({ ...base, publishState: undefined })).toBe(false);
    expect(teamsInstallRefetchInterval(null)).toBe(false);
    expect(teamsInstallRefetchInterval(undefined)).toBe(false);
  });

  // An outdated app waits on a person (a Teams admin publishes, a team owner
  // updates), not on the API, so the notice must not keep the row polling.
  test('does not poll an install whose catalog serves an older app', () => {
    const outdated: TeamsInstallation = {
      ...base,
      orgInstalled: true,
      publishState: 'published',
      appVersion: '1.2.0',
      latestAppVersion: '1.6.0',
      appUpdateAvailable: true,
    };
    expect(teamsInstallRefetchInterval(outdated)).toBe(false);
  });
});
