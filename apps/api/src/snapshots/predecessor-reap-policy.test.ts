import { describe, expect, test } from 'bun:test';
import { isReapableTemplatePredecessor } from './predecessor-reap-policy';

describe('isReapableTemplatePredecessor', () => {
  test.each([
    'kortix-default-runtime',
    'kortix-tpl-project',
    'kortix-wproj-project',
    'kortix-ppwarm-00ead866-f5c859f984f2',
  ])('preserves predecessor deletion for %s', (name) => {
    expect(isReapableTemplatePredecessor(name)).toBe(true);
  });

  test('never admits scoped project images without data-plane ownership proof', () => {
    expect(
      isReapableTemplatePredecessor(
        'kpp2-111111111111-222222222222-3333333333333333-4444444444444444',
      ),
    ).toBe(false);
    expect(isReapableTemplatePredecessor('kpp2-malformed')).toBe(false);
  });

  test('rejects provider and unrelated image namespaces', () => {
    expect(isReapableTemplatePredecessor('daytonaio/sandbox:latest')).toBe(false);
    expect(isReapableTemplatePredecessor('kortix-meta-runtime')).toBe(false);
  });
});
