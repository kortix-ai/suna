/**
 * KRTX-2326, KRTX-2327: the account hub's bulk remove and GitHub permission
 * cell, and the branding tab's upload controls, rendered English on every
 * locale: raw template literals beside translated siblings. They come from the
 * catalog now. This file pins both halves: no raw literal is left in the
 * source, and each message renders in German and Serbian with its plural.
 */
import { describe, expect, test } from 'bun:test';
import { createTranslator } from 'next-intl';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import de from '../../../translations/de.json';
import sr from '../../../translations/sr.json';

const t = createTranslator({ locale: 'de', messages: de, namespace: 'hardcodedUi.i18nComplete' });
const tSr = createTranslator({ locale: 'sr', messages: sr, namespace: 'hardcodedUi.i18nComplete' });

function source(path: string): string {
  return readFileSync(resolve(import.meta.dir, path), 'utf8');
}

describe('account settings copy comes from the catalog', () => {
  test('the account hub has no raw English in its bulk remove and permission cell', () => {
    const hub = source('hub/account-hub-content.tsx');
    for (const literal of [
      'confirmLabel={`Remove ${',
      "bulkRun('Removed'",
      'more — see console',
      "?? 'Unknown error'",
      '`Contents ${',
      "selectedCount === 1 ? '' : 's'",
    ]) {
      expect(hub).not.toContain(literal);
    }
  });

  test('the branding tab has no raw English in its upload controls', () => {
    const branding = source('settings/branding-tab.tsx');
    for (const literal of [
      "? 'Uploaded'",
      "'Replace' : 'Upload'",
      '`Upload ${label}`',
      '`Remove ${label}`',
      '(${scheme})`',
      'capitalize">{scheme}<',
    ]) {
      expect(branding).not.toContain(literal);
    }
  });

  test('the shared confirm dialog defaults to the viewer language, not English', () => {
    const dialog = source('../../../../../packages/ui/src/components/ui/confirm-dialog.tsx');
    expect(dialog).not.toContain("cancelLabel = 'Cancel'");
    expect(dialog).not.toContain("confirmLabel = 'Confirm'");
    expect(t.raw('text4118fb4fed0e')).toBe('Entfernt');
  });

  test('the bulk remove dialog and toasts render in German, with a real plural', () => {
    expect(t('text3028bf7d2dec', { value0: 3 })).toBe('3 entfernen');
    expect(t('text586a24125900', { count: 1, account: 'Synthetic Co' })).toBe(
      '1 Mitglied verliert den Zugriff auf Synthetic Co.',
    );
    expect(t('text586a24125900', { count: 3, account: 'Synthetic Co' })).toBe(
      '3 Mitglieder verlieren den Zugriff auf Synthetic Co.',
    );
    expect(t('text4e9efdcbbcbe', { count: 2 })).toBe(' (+2 weitere – siehe Konsole)');
    expect(t.raw('text4118fb4fed0e')).toBe('Entfernt');
    expect(t('text65ef045d1ffa', { value0: 'write' })).toBe('Inhalte write');
  });

  test('Serbian takes its few form', () => {
    expect(tSr('text586a24125900', { count: 3, account: 'Synthetic Co' })).toBe(
      '3 члана губе приступ Synthetic Co.',
    );
    expect(tSr('text586a24125900', { count: 5, account: 'Synthetic Co' })).toBe(
      '5 чланова губи приступ Synthetic Co.',
    );
  });

  test('the branding upload controls render in German', () => {
    const label = `logo (${t.raw('text99a7026172d4')})`;
    expect(label).toBe('logo (hell)');
    expect(t.raw('text3cc3767e7032')).toBe('Hochgeladen');
    expect(t.raw('text95e154398a4b')).toBe('Ersetzen');
    expect(t.raw('text865e89de78d9')).toBe('Hochladen');
    expect(t('textd0166fa53db8', { value0: label })).toBe('logo (hell) hochladen');
    expect(t('text3028bf7d2dec', { value0: label })).toBe('logo (hell) entfernen');
  });
});
