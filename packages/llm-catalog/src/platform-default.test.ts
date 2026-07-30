import { describe, expect, test } from 'bun:test';

import {
  PLATFORM_DEFAULT_MODEL_ID,
  catalogModelForWireModel,
  getManagedModel,
} from './index';

describe('PLATFORM_DEFAULT_MODEL_ID', () => {
  test('is a concrete managed model', () => {
    expect(PLATFORM_DEFAULT_MODEL_ID).toBe('glm-5.2');
    expect(getManagedModel(PLATFORM_DEFAULT_MODEL_ID)).toBeDefined();
  });

  test('the catalog does not recognize stale auto model ids', () => {
    expect(catalogModelForWireModel('auto')).toBeUndefined();
    expect(catalogModelForWireModel('kortix/auto')).toBeUndefined();
  });
});
