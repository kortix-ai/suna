import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Pins facts of the notification copy people read (KRTX-1742), in every
// catalog.
//
// 1. The Push switches apply on every phone, but a phone also keeps its own
//    switch for the 4 session kinds, and both must be on (`buildExpoMessages`,
//    apps/api/src/notifications/push-payload.ts).
// 2. `notification_center` graduated (2026-11-06): no catalog describes it as
//    a flag any more.

const web = join(import.meta.dir, '../../..');
const read = (path: string) => readFileSync(join(web, path), 'utf8');

const SESSION_KINDS = ['turn_done', 'turn_error', 'question', 'permission'] as const;

const catalogs = readdirSync(join(web, 'translations')).filter((file) => file.endsWith('.json'));

describe('notification copy', () => {
  test('every catalog is covered', () => {
    expect([...catalogs].sort()).toEqual(['de', 'en', 'es', 'fr', 'it', 'ja', 'pt', 'sr', 'zh'].map((l) => `${l}.json`));
  });

  for (const file of catalogs) {
    const catalog = JSON.parse(read(`translations/${file}`));

    test(`${file}: the Push switches description names the kinds a phone also switches`, () => {
      const description: string = catalog.settings.sessions.notificationTypesDescription;
      for (const kind of SESSION_KINDS) expect(description).toContain(catalog.notifications.kind[kind]);
    });

    test(`${file}: the Inbox page has its title, and no flag copy is left`, () => {
      expect(catalog.notifications.inbox.title.length).toBeGreaterThan(0);
      expect(catalog.notifications.inbox.emailOptIn.length).toBeGreaterThan(0);
      expect(catalog.notifications.bell).toBeUndefined();
      expect(catalog.settings.featureFlags.flags.notification_center).toBeUndefined();
    });
  }
});
