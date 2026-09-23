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
});
