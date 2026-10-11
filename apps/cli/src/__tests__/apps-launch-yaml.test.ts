import { describe, expect, test } from 'bun:test';
import { parse } from 'yaml';
import { addAppBlocks } from '../commands/apps-launch-yaml.ts';

const blocks = {
  db: { type: 'oci_image', image: 'example.test/backend@sha256:abc', mounts: [{ source: 'data', destination: '/data' }] },
  'db-dashboard': { type: 'oci_image', image: 'example.test/dashboard@sha256:def', uses: ['db'] },
};

/** Every line of `before` survives, in order: the edit only adds lines. */
function onlyAdds(before: string, after: string): void {
  const kept = after.split('\n');
  let at = 0;
  for (const line of before.split('\n')) {
    const found = kept.indexOf(line, at);
    expect(found).toBeGreaterThanOrEqual(at);
    at = found + 1;
  }
}

describe('kortix apps launch: adding App blocks to kortix.yaml', () => {
  test('inserts into an existing apps map and leaves every other byte alone (flow lists, aligned comments, section headers)', () => {
    const before = [
      'kortix_version: 2',
      'env:',
      '  optional: [STRIPE_API_KEY]',
      'tools:',
      '  web_search: kortix:web_search      # maintained by Kortix',
      '',
      '# ─── Agents ───',
      '# governance only',
      'agents:',
      '  kortix:',
      '    file: agents/kortix.md',
      '',
      '# ─── Apps ───',
      'apps:',
      '  site:',
      '    path: web/dist',
      '    type: static',
      '',
      '# ─── Triggers ───',
      'triggers: []',
      '',
    ].join('\n');
    const after = addAppBlocks(before, blocks);
    onlyAdds(before, after);
    const doc = parse(after);
    expect(Object.keys(doc.apps)).toEqual(['site', 'db', 'db-dashboard']);
    expect(doc.apps.db.mounts[0].destination).toBe('/data');
    expect(doc.apps['db-dashboard'].uses).toEqual(['db']);
    // The new blocks sit inside the Apps section, before the Triggers header.
    expect(after.indexOf('  db:')).toBeLessThan(after.indexOf('# ─── Triggers ───'));
    expect(after).toContain('  optional: [STRIPE_API_KEY]\n');
    expect(after).toContain('# ─── Agents ───\n# governance only\nagents:\n');
  });

  test('appends an apps map to a file without one', () => {
    const before = 'kortix_version: 2\nname: demo\n';
    const after = addAppBlocks(before, blocks);
    onlyAdds(before, after);
    expect(Object.keys(parse(after).apps)).toEqual(['db', 'db-dashboard']);
  });

  test('replaces an empty flow map (`apps: {}`)', () => {
    const after = addAppBlocks('kortix_version: 2\napps: {}\nname: demo\n', blocks);
    const doc = parse(after);
    expect(Object.keys(doc.apps)).toEqual(['db', 'db-dashboard']);
    expect(doc.name).toBe('demo');
  });

  test('starts a file when there is none', () => {
    expect(Object.keys(parse(addAppBlocks('', blocks)).apps)).toEqual(['db', 'db-dashboard']);
  });
});
