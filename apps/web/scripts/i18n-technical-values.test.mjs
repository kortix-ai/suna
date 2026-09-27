import assert from 'node:assert/strict';
import { test } from 'node:test';

import { nonLinguisticBindings, technicalValueKind } from './i18n-technical-values.mjs';

test('classifies machine-read values and leaves prose alone', () => {
  const technical = {
    'matrix(1 0 0 -1 0 1705.333)': 'transform',
    'rotate(40.0516 -3.15 21.41)scale(8.57 12.4)': 'transform',
    'translate(-104px, -52px) scale(0.9)': 'transform',
    'rotate({value0}deg)': 'transform',
    'new 0 0 32 32': 'enable-background',
    'allow-same-origin allow-scripts allow-forms': 'iframe-sandbox',
    'image/*': 'accept-list',
    'image/*,.pdf,.txt': 'accept-list',
    'info@example.com': 'email',
    'https://example.com/docs': 'url',
    'size-4 shrink-0 text-muted-foreground': 'class-list',
    'text-red-500 dark:text-red-400': 'class-list',
  };
  for (const [value, kind] of Object.entries(technical)) {
    assert.equal(technicalValueKind(value), kind, value);
  }
  for (const prose of [
    'Save changes',
    'Rotate the page',
    'kortix init my-project',
    'session/outreach',
    'block text',
    'my-api',
  ]) {
    assert.equal(technicalValueKind(prose), null, prose);
  }
});

test('finds translated values bound to non-linguistic attributes and properties', () => {
  const source = `
    const a = <linearGradient gradientTransform={tI18nHardcoded.raw('k1')} />;
    const b = <iframe sandbox={t('k2')} title={t('ok1')} />;
    const c = { transform: flag ? undefined : tI18nComplete('k3', { value0: 1 }) };
    const d = icon({ className: tX.raw('k4'), label: tX.raw('ok2') });
    const e = <input accept={t('k5')} placeholder={t('ok3')} />;
  `;
  assert.deepEqual(
    nonLinguisticBindings(source).map((finding) => [finding.name, finding.key]),
    [
      ['gradientTransform', 'k1'],
      ['sandbox', 'k2'],
      ['transform', 'k3'],
      ['className', 'k4'],
      ['accept', 'k5'],
    ],
  );
});
