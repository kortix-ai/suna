import { describe, expect, test } from 'bun:test';
import { buildPublicTemplateUrl } from './template-url';

describe('buildPublicTemplateUrl', () => {
  test('builds the public template URL from a UUID', () => {
    expect(
      buildPublicTemplateUrl(
        'https://dev-api.kortix.com/v1/',
        '550e8400-e29b-41d4-a716-446655440000',
      )?.toString(),
    ).toBe('https://dev-api.kortix.com/v1/templates/public/550e8400-e29b-41d4-a716-446655440000');
  });

  test('rebuilds an uppercase UUID as canonical lowercase hexadecimal', () => {
    expect(
      buildPublicTemplateUrl(
        'https://dev-api.kortix.com/v1',
        '550E8400-E29B-41D4-A716-446655440000',
      )?.toString(),
    ).toBe('https://dev-api.kortix.com/v1/templates/public/550e8400-e29b-41d4-a716-446655440000');
  });

  test.each([
    '../accounts',
    '550e8400-e29b-41d4-a716-446655440000/../../accounts',
    'https://attacker.example/path',
    '550e8400-e29b-41d4-a716-44665544000g',
    '',
  ])('rejects an invalid shareId: %s', (shareId) => {
    expect(buildPublicTemplateUrl('https://dev-api.kortix.com/v1', shareId)).toBeNull();
  });
});
