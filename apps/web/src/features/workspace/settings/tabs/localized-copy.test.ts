import { expect, test } from 'bun:test';
import { localizedCopy } from './localized-copy';
test('localizedCopy translates nested leaves and connected interpolation', () => {
  const copy = localizedCopy(
    {
      nested: { label: 'Label' },
      connectedAs: (name: string) => name,
      moreInstallations: (count: number) => String(count),
    },
    (key, values) => `${key}:${JSON.stringify(values ?? {})}`,
  );
  expect(copy.nested.label).toBe('nested.label:{}');
  expect(copy.connectedAs('synthetic')).toBe('connectedAs:{"name":"synthetic"}');
  expect(copy.moreInstallations(2)).toBe('moreInstallations:{"count":2}');
});
