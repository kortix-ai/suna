import AsyncStorage from '@react-native-async-storage/async-storage';
import { describe, expect, test } from 'bun:test';

import { useGenuiStore } from './genui-store';

describe('genui store', () => {
  test('defaults to on', () => {
    expect(useGenuiStore.getState().enabled).toBe(true);
  });

  test('setEnabled persists the choice', async () => {
    useGenuiStore.getState().setEnabled(false);
    expect(useGenuiStore.getState().enabled).toBe(false);
    const raw = await AsyncStorage.getItem('kortix-genui');
    expect(JSON.parse(raw!).state.enabled).toBe(false);
    useGenuiStore.getState().setEnabled(true);
  });
});
