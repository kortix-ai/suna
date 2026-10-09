import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Pins two facts of the `notification_center` flag (KRTX-1742) in the copy
// people read. Both were false in the first flag build.
//
// 1. Flag off: a session pushes only its creator's phone, AND an account
//    owner's phone gets one push when a trigger starts failing
//    (apps/api/src/projects/lib/trigger-run-outcome.ts).
// 2. Flag on: the Push switches apply on every phone, but a phone also keeps
//    its own switch for the 4 session kinds, and both must be on
//    (`buildExpoMessages`, apps/api/src/notifications/push-payload.ts).

const web = join(import.meta.dir, '../../..');
const read = (path: string) => readFileSync(join(web, path), 'utf8');
const flat = (text: string) => text.replace(/\s+/g, ' ');

const SESSION_KINDS = ['turn_done', 'turn_error', 'question', 'permission'] as const;

/** How each catalog names an account owner in the flag description. */
const ACCOUNT_OWNER: Record<string, string> = {
  'en.json': "account owner's phone",
  'de.json': 'Kontoinhabers',
  'es.json': 'propietario de la cuenta',
  'fr.json': 'propriétaire du compte',
  'it.json': 'proprietario dell’account',
  'ja.json': 'アカウントオーナー',
  'pt.json': 'proprietário da conta',
  'sr.json': 'власника налога',
  'zh.json': '账户所有者',
};

const catalogs = readdirSync(join(web, 'translations')).filter((file) => file.endsWith('.json'));

describe('notification_center copy', () => {
  test('every catalog is covered', () => {
    expect([...catalogs].sort()).toEqual(Object.keys(ACCOUNT_OWNER).sort());
  });

  for (const file of catalogs) {
    const catalog = JSON.parse(read(`translations/${file}`));

    test(`${file}: the flag description names the account owner's push`, () => {
      const description: string = catalog.settings.featureFlags.flags.notification_center.description;
      expect(description).toContain(ACCOUNT_OWNER[file]);
    });

    test(`${file}: the Push switches description names the kinds a phone also switches`, () => {
      const description: string = catalog.settings.sessions.notificationTypesDescription;
      for (const kind of SESSION_KINDS) expect(description).toContain(catalog.notifications.kind[kind]);
    });
  }

  test('the registry, the flag docs, and the sessions docs name both flag-off pushes', () => {
    const registry = read('../api/src/feature-flags/registry.ts');
    const entry = registry.slice(registry.indexOf("key: 'notification_center'"));
    for (const text of [
      entry.slice(0, entry.indexOf('enforcementNote')),
      flat(read('content/docs/feature-flags/index.mdx')),
      flat(read('content/docs/work/sessions.mdx')),
    ]) {
      expect(text).toContain("only the session creator's phone gets a session push");
      expect(text).toContain("an account owner's phone gets one when a trigger starts failing");
    }
  });

  test('the notifications docs say a phone also has its own switch', () => {
    const docs = flat(read('content/docs/work/notifications.mdx'));
    expect(docs).toContain(
      'A phone also has its own switch for **Turn finished**, **Turn failed**, **Question**, and **Permission request**. It gets these only while both switches are on.',
    );
  });
});
