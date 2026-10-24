import { describe, expect, test } from 'bun:test';
import { declaredAppFields, manifestFieldsOf, withAppFields } from './app-manifest';

describe('kortix.yaml owns the App fields it can declare', () => {
  test('manifestFieldsOf keeps only the fields kortix.yaml can declare', () => {
    expect(manifestFieldsOf({ name: 'x', cpu: 2, always_on: true, display: { listed: true }, external_url: 'https://e.test', uses: ['db'] }))
      .toEqual({ cpu: 2, always_on: true, display: { listed: true }, uses: ['db'] });
    expect(manifestFieldsOf({ name: 'only a name' })).toEqual({});
  });

  test('withAppFields writes them into the block: size under resources, the rest at the top; other keys stay', () => {
    const block = { path: 'apps/web/dist', type: 'static', resources: { disk_gb: 20 } };
    expect(withAppFields(block, { cpu: 2, memory_gb: 4, idle_timeout_seconds: 600, always_on: false, labels: ['ops'], display: { listed: true }, uses: [] }))
      .toEqual({
        path: 'apps/web/dist', type: 'static',
        resources: { disk_gb: 20, cpu: 2, memory_gb: 4 },
        idle_timeout_seconds: 600, always_on: false, labels: ['ops'], display: { listed: true }, uses: [],
      });
    expect(withAppFields(undefined, { display: { listed: false } })).toEqual({ display: { listed: false } });
  });

  test('declaredAppFields reads back exactly what a block declares, and nothing it does not', () => {
    expect(declaredAppFields({ path: 'x', resources: { cpu: 2 }, always_on: true, display: { listed: true } }))
      .toEqual({ cpu: 2, always_on: true, display: { listed: true } });
    expect(declaredAppFields({ path: 'x' })).toEqual({});
    const round = withAppFields({ path: 'x' }, { cpu: 1, memory_gb: 2, disk_gb: 10, labels: ['a'], uses: ['db'] });
    expect(declaredAppFields(round)).toEqual({ cpu: 1, memory_gb: 2, disk_gb: 10, labels: ['a'], uses: ['db'] });
  });
});
