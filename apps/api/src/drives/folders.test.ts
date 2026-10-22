import { describe, expect, test } from 'bun:test';
import { folderKnownToTree } from './folders';

describe('folderKnownToTree', () => {
  const grants = [{ path: '/Users/ana' }, { path: '/Research/Q3' }];

  test('a person’s folder, and a shared one, before anything was written to them', () => {
    expect(folderKnownToTree('/Users/ana', grants)).toBe(true);
    expect(folderKnownToTree('/Research', grants)).toBe(true);
    expect(folderKnownToTree('/Research/Q3', grants)).toBe(true);
    expect(folderKnownToTree('/Users', [])).toBe(true);
    expect(folderKnownToTree('/Company', [])).toBe(true);
  });

  test('anything else is not found', () => {
    expect(folderKnownToTree('/Users/bob', grants)).toBe(false);
    expect(folderKnownToTree('/Research/Q3/drafts', grants)).toBe(false);
    expect(folderKnownToTree('/workspace', grants)).toBe(false);
  });
});
