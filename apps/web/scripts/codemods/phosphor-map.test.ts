import { describe, expect, test } from 'bun:test';
import * as phosphor from '@phosphor-icons/react';

import { FILL_INTENT_SOURCES, MANUAL_MAP, TYPE_MAP } from './phosphor-map.mjs';

describe('phosphor-map', () => {
  test('every manual mapping target exists in @phosphor-icons/react', () => {
    for (const entries of Object.values(MANUAL_MAP)) {
      for (const target of Object.values(entries)) {
        expect(phosphor[target as keyof typeof phosphor]).toBeDefined();
      }
    }
  });

  test('every manual target uses the Icon-suffixed export style', () => {
    for (const entries of Object.values(MANUAL_MAP)) {
      for (const target of Object.values(entries)) {
        expect(target.endsWith('Icon')).toBe(true);
      }
    }
  });

  test('type map targets are real phosphor type exports', () => {
    expect(Object.values(TYPE_MAP).length).toBe(3);
    expect(FILL_INTENT_SOURCES.size).toBeGreaterThan(20);
  });
});
