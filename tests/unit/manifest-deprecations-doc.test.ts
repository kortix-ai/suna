// Every kortix.yaml deprecation is documented: the "Deprecated keys" table in
// the public reference has one row per DEPRECATIONS id, so a person can look up
// what a `fix:` warning means and what to write instead.
import { describe, expect, test } from 'vitest';
import { DEPRECATIONS } from '../../packages/manifest-schema/src/deprecations';
import { readRepoFile } from '../src/fixtures/repo';

const DOCS = readRepoFile('apps/web/content/docs/developers.mdx');
const TABLE = DOCS.slice(DOCS.indexOf('### Deprecated keys'), DOCS.indexOf('### ', DOCS.indexOf('### Deprecated keys') + 4));

describe('the Deprecated keys table', () => {
  test('exists', () => expect(TABLE.length).toBeGreaterThan(0));
  test.each(DEPRECATIONS.map((d) => [d.id]))('documents %s', (id) => {
    expect(TABLE).toContain(`| \`${id}\` |`);
  });
});
