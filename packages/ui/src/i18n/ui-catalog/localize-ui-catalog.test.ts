import { expect, test } from 'bun:test';
import { localizeUiCatalog } from './localize-ui-catalog';

test('a structural key keeps its value when the same word has a translation', () => {
  const catalog: Record<string, string> = { k1: 'passaggi', k2: 'Correggi il webhook' };
  const t = Object.assign((key: string) => catalog[key], { raw: (key: string) => catalog[key] });
  const card = { kind: 'steps', title: 'Fix the webhook', steps: ['steps'] };
  const out = localizeUiCatalog(card, t as never, { steps: 'k1', 'Fix the webhook': 'k2' });
  expect(out).toEqual({ kind: 'steps', title: 'Correggi il webhook', steps: ['passaggi'] });
});
