import { beforeEach, describe, expect, test } from 'bun:test';

import { disclosureKey, useDisclosureStore } from './disclosure-store';

describe('disclosure store', () => {
  beforeEach(() => useDisclosureStore.getState().clear());

  test('an untouched id has no user choice', () => {
    expect(useDisclosureStore.getState().choices['thought:prt_1']).toBeUndefined();
  });

  test('a toggle is remembered per id, independent of other ids', () => {
    const { setChoice } = useDisclosureStore.getState();
    setChoice('thought:prt_1', false);
    setChoice('tool:prt_2', true);
    const { choices } = useDisclosureStore.getState();
    expect(choices['thought:prt_1']).toBe(false);
    expect(choices['tool:prt_2']).toBe(true);
  });

  test('the choice survives a remount — it lives outside the component', () => {
    useDisclosureStore.getState().setChoice('thought:prt_3', true);
    // A recycled FlatList cell reads the same store on its next mount.
    expect(useDisclosureStore.getState().choices['thought:prt_3']).toBe(true);
  });

  test('setting the same value keeps the state object stable', () => {
    const { setChoice } = useDisclosureStore.getState();
    setChoice('thought:prt_1', true);
    const before = useDisclosureStore.getState().choices;
    setChoice('thought:prt_1', true);
    expect(useDisclosureStore.getState().choices).toBe(before);
  });

  test('clear forgets every choice', () => {
    useDisclosureStore.getState().setChoice('thought:prt_1', true);
    useDisclosureStore.getState().clear();
    expect(useDisclosureStore.getState().choices).toEqual({});
  });

  test('keys are namespaced by row kind', () => {
    expect(disclosureKey('thought', 'prt_1')).toBe('thought:prt_1');
    expect(disclosureKey('tool', 'prt_1')).not.toBe(disclosureKey('thought', 'prt_1'));
  });
});
