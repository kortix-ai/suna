import { describe, expect, test } from 'bun:test';

import type { FlatModel } from '@kortix/sdk/react';
import { modelInDefaultView } from './model-picker-default-view';

const m = (providerID: string, modelID: string) => ({ providerID, modelID }) as FlatModel;

// Field report (native OpenRouter key): the picker rendered all ~355 models as
// a wall in BOTH the pre-runtime and runtime states — native lists carry no
// server-stamped `enabled`, so nothing curated the default view the way
// /model-picker curates gateway catalogs. This rule is the client twin.
describe('modelInDefaultView', () => {
  const hiddenByStore = () => false;
  const shownByStore = () => true;

  test('native models follow the store visibility rule when not searching', () => {
    const model = m('openrouter', 'old/thing');
    expect(
      modelInDefaultView(model, { search: '', isStoreVisible: hiddenByStore, selected: null }),
    ).toBe(false);
    expect(
      modelInDefaultView(model, { search: '', isStoreVisible: shownByStore, selected: null }),
    ).toBe(true);
  });

  test('a search query reveals everything — typing is intent', () => {
    expect(
      modelInDefaultView(m('openrouter', 'old/thing'), {
        search: 'old',
        isStoreVisible: hiddenByStore,
        selected: null,
      }),
    ).toBe(true);
  });

  test('gateway (kortix) models are untouched — the server already curated them via enabled', () => {
    expect(
      modelInDefaultView(m('kortix', 'glm-5.3-flash'), {
        search: '',
        isStoreVisible: hiddenByStore,
        selected: null,
      }),
    ).toBe(true);
  });

  test('the selected model always renders, even when the store hides it', () => {
    expect(
      modelInDefaultView(m('openrouter', 'old/thing'), {
        search: '',
        isStoreVisible: hiddenByStore,
        selected: { providerID: 'openrouter', modelID: 'old/thing' },
      }),
    ).toBe(true);
  });
});
