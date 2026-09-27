import { describe, expect, test } from 'bun:test';

import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

import { locales } from '../src/i18n/catalog.mjs';
import {
  catalogFiles,
  findKeyOrderChanges,
  mergeCatalogTexts,
  mergeCatalogs,
  mergeKeyOrder,
  restoreKeyOrder,
  sameIgnoringOrder,
  serializeCatalog,
} from './i18n-catalogs.mjs';

const repoRoot = resolve(import.meta.dir, '../../..');

// `toEqual` ignores key order, and key order is the subject here.
function inOrder(value) {
  return JSON.stringify(value);
}

function deepFreeze(value) {
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function firstDifference(actual, expected) {
  const a = actual.split('\n');
  const e = expected.split('\n');
  const index = a.findIndex((line, i) => line !== e[i]);
  if (index === -1 && a.length === e.length) return null;
  const at = index === -1 ? Math.min(a.length, e.length) : index;
  return `line ${at + 1}: ${JSON.stringify(a[at])} should be ${JSON.stringify(e[at])}`;
}

describe('the committed catalogs', () => {
  // A catalog is exactly what `JSON.stringify(value, null, 2)` writes, so a
  // tool that parses and rewrites one — the merge driver included — changes
  // only what it means to change. The 2026-09-22 merge also broke this: the
  // program that reordered the keys wrote integer keys as "5", "4", "3", which
  // no JSON.stringify can produce.
  for (const file of catalogFiles) {
    test(`${basename(file)} is canonical`, () => {
      const text = readFileSync(file, 'utf8');
      expect(firstDifference(text, serializeCatalog(JSON.parse(text)))).toBeNull();
    });
  }
});

describe('findKeyOrderChanges', () => {
  test('adding and removing keys is not a reorder', () => {
    expect(findKeyOrderChanges({ a: 1, b: 2, c: 3 }, { a: 1, x: 0, c: 3, d: 4 })).toEqual([]);
  });

  test('a moved key is reported at the first position that differs', () => {
    expect(findKeyOrderChanges({ a: 1, b: 2, c: 3 }, { a: 1, c: 3, b: 2 })).toEqual([
      { path: [], index: 1, expected: 'b', actual: 'c', shared: 3 },
    ]);
  });

  test('each nested object is compared under its own path', () => {
    const before = { starterPrompts: { items: { first: 'A', second: 'B' } } };
    const after = { starterPrompts: { items: { second: 'B', first: 'A' } } };
    expect(findKeyOrderChanges(before, after)).toEqual([
      {
        path: ['starterPrompts', 'items'],
        index: 0,
        expected: 'first',
        actual: 'second',
        shared: 2,
      },
    ]);
  });

  test('an array is a value, not an object with an order to keep', () => {
    expect(findKeyOrderChanges({ list: ['a', 'b'] }, { list: ['b', 'a'] })).toEqual([]);
  });
});

describe('mergeKeyOrder', () => {
  const keep = (...keys) => new Set(keys);

  test("each side's new key stays next to the key it followed", () => {
    expect(
      mergeKeyOrder(
        ['a', 'b', 'c'],
        ['a', 'x', 'b', 'c'],
        ['a', 'b', 'y', 'c'],
        keep('a', 'b', 'c', 'x', 'y'),
      ),
    ).toEqual(['a', 'x', 'b', 'y', 'c']);
  });

  // Merging main (theirs) into a branch (ours) that both appended to one
  // object: main's keys first, then the branch's, as a rebase would order them.
  test('two runs appended after the same key are both kept, theirs first', () => {
    expect(
      mergeKeyOrder(['a'], ['a', 'o1', 'o2'], ['a', 't1'], keep('a', 'o1', 'o2', 't1')),
    ).toEqual(['a', 't1', 'o1', 'o2']);
  });

  test('a deleted key neither survives nor anchors: a key added after it takes its place', () => {
    expect(
      mergeKeyOrder(['a', 'b', 'c'], ['a', 'c'], ['a', 'b', 'y', 'c'], keep('a', 'c', 'y')),
    ).toEqual(['a', 'y', 'c']);
  });

  test('the side that reordered its keys sets the order', () => {
    expect(
      mergeKeyOrder(
        ['a', 'b', 'c'],
        ['a', 'b', 'c', 'x'],
        ['c', 'b', 'a'],
        keep('a', 'b', 'c', 'x'),
      ),
    ).toEqual(['c', 'x', 'b', 'a']);
  });
});

describe('mergeCatalogs', () => {
  test('two branches that add keys to the same objects merge cleanly, in both orders', () => {
    const base = { common: { save: 'Save', cancel: 'Cancel' }, settings: { title: 'Settings' } };
    const ours = {
      common: { save: 'Save', ok: 'OK', cancel: 'Cancel' },
      settings: { title: 'Settings', theme: 'Theme' },
    };
    const theirs = {
      common: { save: 'Save', cancel: 'Cancel', close: 'Close' },
      agents: { title: 'Agents' },
      settings: { title: 'Settings' },
    };
    const { value, conflicts } = mergeCatalogs(base, ours, theirs);
    expect(conflicts).toEqual([]);
    expect(inOrder(value)).toBe(
      inOrder({
        common: { save: 'Save', ok: 'OK', cancel: 'Cancel', close: 'Close' },
        agents: { title: 'Agents' },
        settings: { title: 'Settings', theme: 'Theme' },
      }),
    );
  });

  test('an edit on one side and a new key on the other both land', () => {
    const { value, conflicts } = mergeCatalogs(
      { common: { save: 'Save' } },
      { common: { save: 'Save changes' } },
      { common: { save: 'Save', undo: 'Undo' } },
    );
    expect(conflicts).toEqual([]);
    expect(inOrder(value)).toBe(inOrder({ common: { save: 'Save changes', undo: 'Undo' } }));
  });

  // The 2026-09-22 merge kept four such keys in every catalog: it took the
  // union of both sides and never deleted.
  test('a key deleted on one side and untouched on the other is deleted', () => {
    const { value, conflicts } = mergeCatalogs(
      { a: 'A', old: 'Old', b: 'B' },
      { a: 'A', b: 'B' },
      { a: 'A', old: 'Old', b: 'B', c: 'C' },
    );
    expect(conflicts).toEqual([]);
    expect(inOrder(value)).toBe(inOrder({ a: 'A', b: 'B', c: 'C' }));
  });

  test('the same key added with the same text on both sides is one key', () => {
    const { value, conflicts } = mergeCatalogs(
      { a: 'A' },
      { a: 'A', n: 'New' },
      { a: 'A', n: 'New' },
    );
    expect(conflicts).toEqual([]);
    expect(inOrder(value)).toBe(inOrder({ a: 'A', n: 'New' }));
  });

  test('the same key changed two ways is a conflict that holds ours in the value', () => {
    const { value, conflicts } = mergeCatalogs(
      { common: { save: 'Save', undo: 'Undo' } },
      { common: { save: 'Store', undo: 'Undo' } },
      { common: { save: 'Keep', undo: 'Undo' } },
    );
    expect(conflicts).toEqual([
      {
        path: ['common', 'save'],
        base: { present: true, value: 'Save' },
        ours: { present: true, value: 'Store' },
        theirs: { present: true, value: 'Keep' },
      },
    ]);
    expect(value.common.save).toBe('Store');
  });

  test('a key deleted on one side and changed on the other is a conflict', () => {
    const { conflicts } = mergeCatalogs({ a: 'A', b: 'B' }, { a: 'A' }, { a: 'A', b: 'B2' });
    expect(conflicts).toEqual([
      {
        path: ['b'],
        base: { present: true, value: 'B' },
        ours: { present: false },
        theirs: { present: true, value: 'B2' },
      },
    ]);
  });

  test('the same new key with different text on each side is a conflict', () => {
    const { conflicts } = mergeCatalogs({}, { n: 'One' }, { n: 'Two' });
    expect(conflicts.map((conflict) => conflict.path)).toEqual([['n']]);
    expect(conflicts[0].base).toEqual({ present: false });
  });

  test('an array merges as one value', () => {
    const base = { greetings: ['Hi', 'Hello'] };
    expect(mergeCatalogs(base, { greetings: ['Hi', 'Hey'] }, base).value).toEqual({
      greetings: ['Hi', 'Hey'],
    });
    expect(
      mergeCatalogs(base, { greetings: ['Hi', 'Hey'] }, { greetings: ['Yo'] }).conflicts.map(
        (c) => c.path,
      ),
    ).toEqual([['greetings']]);
  });

  test('integer keys stay in ascending order, as JSON.stringify writes them', () => {
    const { value } = mergeCatalogs(
      { 1: 'one', 2: 'two' },
      { 1: 'one', 2: 'two', 3: 'three' },
      { 0: 'zero', 1: 'one', 2: 'two' },
    );
    expect(Object.keys(value)).toEqual(['0', '1', '2', '3']);
  });

  test('no input is modified', () => {
    const base = deepFreeze({ a: { x: 'X' }, b: 'B' });
    const ours = deepFreeze({ a: { x: 'X', y: 'Y' }, b: 'B' });
    const theirs = deepFreeze({ a: { w: 'W', x: 'X' }, b: 'B2' });
    expect(inOrder(mergeCatalogs(base, ours, theirs).value)).toBe(
      inOrder({ a: { w: 'W', x: 'X', y: 'Y' }, b: 'B2' }),
    );
  });
});

describe('restoreKeyOrder', () => {
  test('puts a scrambled catalog back in the reference order without changing a value', () => {
    const reference = { a: { x: 'X', y: 'Y' }, b: 'B', c: 'C' };
    const scrambled = { c: 'C', b: 'B edited', a: { y: 'Y', x: 'X' } };
    const restored = restoreKeyOrder(scrambled, [reference]);
    expect(inOrder(restored)).toBe(inOrder({ a: { x: 'X', y: 'Y' }, b: 'B edited', c: 'C' }));
    expect(sameIgnoringOrder(restored, scrambled)).toBe(true);
  });

  test('a key the reference lacks follows the key it follows now', () => {
    expect(inOrder(restoreKeyOrder({ c: 3, a: 1, n: 0 }, [{ a: 1, c: 3 }]))).toBe(
      inOrder({ a: 1, n: 0, c: 3 }),
    );
  });

  // The 2026-09-22 repair: main before the merge sets the order, and the
  // merged branch places the keys it added.
  test('a second reference places the keys the first one lacks', () => {
    const main = { a: 'A', c: 'C' };
    const branch = { a: 'A', b: 'B', c: 'C' };
    expect(inOrder(restoreKeyOrder({ c: 'C', b: 'B', a: 'A' }, [main, branch]))).toBe(
      inOrder({ a: 'A', b: 'B', c: 'C' }),
    );
  });
});

describe('mergeCatalogTexts', () => {
  const base = { common: { save: 'Save', undo: 'Undo', close: 'Close' }, nav: { home: 'Home' } };

  function sides(text) {
    const pick = (side) => {
      let mode = 'both';
      const lines = [];
      for (const line of text.split('\n')) {
        if (line.startsWith('<<<<<<< ')) mode = 'ours';
        else if (line.startsWith('=======')) mode = 'theirs';
        else if (line.startsWith('>>>>>>> ')) mode = 'both';
        else if (mode === 'both' || mode === side) lines.push(line);
      }
      return JSON.parse(lines.join('\n'));
    };
    return { ours: pick('ours'), theirs: pick('theirs') };
  }

  test('a clean merge is written in canonical form', () => {
    const ours = { ...base, nav: { home: 'Home', agents: 'Agents' } };
    const theirs = { ...base, common: { ...base.common, undo: 'Undo last' } };
    const { text, conflicts } = mergeCatalogTexts(
      serializeCatalog(base),
      serializeCatalog(ours),
      serializeCatalog(theirs),
    );
    expect(conflicts).toEqual([]);
    expect(text).toBe(
      serializeCatalog({
        common: { save: 'Save', undo: 'Undo last', close: 'Close' },
        nav: { home: 'Home', agents: 'Agents' },
      }),
    );
  });

  // Both sides start the object, so their keys share its start as the anchor:
  // theirs first, as for any two runs added after the same key.
  test('an empty base means both sides added the file', () => {
    const { text, conflicts } = mergeCatalogTexts(
      '',
      serializeCatalog({ a: 'A' }),
      serializeCatalog({ b: 'B' }),
    );
    expect(conflicts).toEqual([]);
    expect(text).toBe(serializeCatalog({ b: 'B', a: 'A' }));
  });

  test('conflict markers surround the conflicting key and nothing else', () => {
    const ours = {
      common: { ...base.common, save: 'Store' },
      nav: { home: 'Home', agents: 'Agents' },
    };
    const theirs = { common: { ...base.common, save: 'Keep', close: 'Dismiss' }, nav: base.nav };
    const { text, conflicts } = mergeCatalogTexts(
      serializeCatalog(base),
      serializeCatalog(ours),
      serializeCatalog(theirs),
      { labels: ['HEAD', 'base', 'origin/main'] },
    );
    expect(conflicts.map((conflict) => conflict.path)).toEqual([['common', 'save']]);
    expect(text).toContain(
      [
        '<<<<<<< HEAD',
        '    "save": "Store",',
        '=======',
        '    "save": "Keep",',
        '>>>>>>> origin/main',
      ].join('\n'),
    );
    expect(text.match(/^<<<<<<< /gm)).toHaveLength(1);
    const { ours: oursSide, theirs: theirsSide } = sides(text);
    expect(inOrder(oursSide)).toBe(
      inOrder({
        common: { save: 'Store', undo: 'Undo', close: 'Dismiss' },
        nav: { home: 'Home', agents: 'Agents' },
      }),
    );
    expect(inOrder(theirsSide)).toBe(
      inOrder({
        common: { save: 'Keep', undo: 'Undo', close: 'Dismiss' },
        nav: { home: 'Home', agents: 'Agents' },
      }),
    );
  });

  test('default conflict markers ignore a caller diff3 setting', () => {
    const keys = ['GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0'];
    const previous = keys.map((key) => process.env[key]);
    try {
      process.env.GIT_CONFIG_COUNT = '1';
      process.env.GIT_CONFIG_KEY_0 = 'merge.conflictStyle';
      process.env.GIT_CONFIG_VALUE_0 = 'diff3';
      const { text } = mergeCatalogTexts(
        serializeCatalog(base),
        serializeCatalog({ ...base, common: { ...base.common, save: 'Store' } }),
        serializeCatalog({ ...base, common: { ...base.common, save: 'Keep' } }),
      );
      expect(text).toContain('<<<<<<< ours');
      expect(text).toContain('=======');
      expect(text).not.toContain('||||||| base');
      const explicit = mergeCatalogTexts(
        serializeCatalog(base),
        serializeCatalog({ ...base, common: { ...base.common, save: 'Store' } }),
        serializeCatalog({ ...base, common: { ...base.common, save: 'Keep' } }),
        { conflictStyle: 'diff3' },
      );
      expect(explicit.text).toContain('||||||| base');
    } finally {
      keys.forEach((key, index) => {
        if (previous[index] === undefined) delete process.env[key];
        else process.env[key] = previous[index];
      });
    }
  });

  // The comma after the previous key depends on which side wins, so the hunk
  // takes that line in too, and either choice is valid JSON.
  test('deleting the last key of an object against an edit to it gives valid JSON on either side', () => {
    const ours = { ...base, common: { save: 'Save', undo: 'Undo' } };
    const theirs = { ...base, common: { ...base.common, close: 'Dismiss' } };
    const { text, conflicts } = mergeCatalogTexts(
      serializeCatalog(base),
      serializeCatalog(ours),
      serializeCatalog(theirs),
    );
    expect(conflicts.map((conflict) => conflict.path)).toEqual([['common', 'close']]);
    const { ours: oursSide, theirs: theirsSide } = sides(text);
    expect(oursSide.common).toEqual({ save: 'Save', undo: 'Undo' });
    expect(theirsSide.common).toEqual({ save: 'Save', undo: 'Undo', close: 'Dismiss' });
  });

  test('text that is not JSON is refused, so the driver falls back to a text merge', () => {
    expect(() => mergeCatalogTexts('{}', '<<<<<<< HEAD', '{}')).toThrow();
  });
});

// Git reads only these tests' configuration: no global hooks, signing, or
// conflict style from the machine that runs them.
const gitEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
};
// GITHUB_BASE_REF is set on a labelled pull request's test run and changes the
// repair hint that `check` prints.
for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GITHUB_BASE_REF']) {
  delete gitEnv[key];
}

const catalogPath = (locale) => `apps/web/translations/${locale}.json`;

// A throwaway repository wired the way `pnpm install` wires this one: the real
// .gitattributes, the real registration script, the real driver.
function repository({ withDriverScript = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'i18n-catalogs-'));
  const run = (command, args, env = {}) =>
    spawnSync(command, args, { cwd: dir, env: { ...gitEnv, ...env }, encoding: 'utf8' });
  const git = (...args) => {
    const result = run('git', args);
    if (result.status !== 0 && !['merge', 'cherry-pick'].includes(args[0])) {
      throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
    }
    return result;
  };
  const copy = (path) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    copyFileSync(join(repoRoot, path), join(dir, path));
  };
  git('init', '-q', '-b', 'main');
  copy('.gitattributes');
  copy('scripts/register-merge-drivers.sh');
  if (withDriverScript) {
    copy('apps/web/scripts/i18n-catalogs.mjs');
    copy('apps/web/src/i18n/catalog.mjs');
  }
  expect(run('sh', ['scripts/register-merge-drivers.sh']).status).toBe(0);
  const writeText = (text, locale = 'en') => {
    mkdirSync(dirname(join(dir, catalogPath(locale))), { recursive: true });
    writeFileSync(join(dir, catalogPath(locale)), text);
  };
  return {
    git,
    cli: (...args) => run('node', ['apps/web/scripts/i18n-catalogs.mjs', ...args]),
    cliWithEnv: (env, ...args) => run('node', ['apps/web/scripts/i18n-catalogs.mjs', ...args], env),
    writeText,
    write: (value, locale = 'en') => writeText(serializeCatalog(value), locale),
    read: (locale = 'en') => readFileSync(join(dir, catalogPath(locale)), 'utf8'),
    commit: (message) => {
      git('add', '-A');
      git('commit', '-q', '-m', message);
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

describe('how this repository is wired', () => {
  test('.gitattributes sends every catalog to the i18n-catalog merge driver', () => {
    for (const file of catalogFiles) {
      const result = spawnSync('git', ['check-attr', 'merge', '--', file], {
        cwd: repoRoot,
        encoding: 'utf8',
      });
      expect(result.stdout.trim()).toEndWith(': merge: i18n-catalog');
    }
  });

  // A driver named in .gitattributes but never registered is silently skipped,
  // so registration rides on `pnpm install`, which everyone runs.
  test('the root prepare script registers the merge drivers', () => {
    const { scripts } = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
    expect(scripts.prepare).toContain('sh scripts/register-merge-drivers.sh');
  });
});

describe('the check and restore-order commands', () => {
  const catalog = {
    common: { save: 'Save', cancel: 'Cancel' },
    nav: { home: 'Home', agents: 'Agents' },
  };

  test('check fails on a reordered catalog, and restore-order repairs it without changing a value', () => {
    const repo = repository();
    try {
      for (const locale of locales) repo.write(catalog, locale);
      repo.commit('catalogs');
      repo.write({ common: catalog.common, nav: { agents: 'Agents', home: 'Home' } }, 'de');

      const check = repo.cli('check', '--base=HEAD');
      expect(check.status).toBe(1);
      expect(check.stdout).toContain('en.json: ok');
      expect(check.stdout).toContain(
        [
          'de.json:',
          '  reorders 1 object(s) it shares with HEAD:',
          '    nav: position 1 of 2 holds "agents", HEAD has "home"',
        ].join('\n'),
      );
      expect(check.stdout).toContain('restore-order --from=HEAD [');

      // In CI the base is the test merge's parent, which means nothing on a
      // laptop: the hint names the pull request's base branch instead.
      const ci = repo.cliWithEnv({ GITHUB_BASE_REF: 'main' }, 'check', '--base=HEAD');
      expect(ci.stdout).toContain('restore-order --from=origin/main [');

      expect(repo.cli('restore-order', '--from=HEAD').status).toBe(0);
      expect(repo.read('de')).toBe(serializeCatalog(catalog));
      expect(repo.cli('check', '--base=HEAD').status).toBe(0);
    } finally {
      repo.cleanup();
    }
  });

  test('check fails on a catalog that is not canonical, and format fixes it', () => {
    const repo = repository();
    try {
      for (const locale of locales) repo.write(catalog, locale);
      repo.writeText(`${JSON.stringify(catalog, null, 4)}\n`, 'ja');

      const check = repo.cli('check');
      expect(check.status).toBe(1);
      expect(check.stdout).toContain('ja.json:\n  not canonical from line 2;');
      // Nothing moved, so there is no reorder repair to suggest.
      expect(check.stdout).not.toContain('restore-order');
      expect(repo.cli('format').status).toBe(0);
      expect(repo.read('ja')).toBe(serializeCatalog(catalog));
      expect(repo.cli('check').status).toBe(0);
    } finally {
      repo.cleanup();
    }
  });

  // A guard that compares against a typo must not pass.
  test('check refuses a base revision that does not exist', () => {
    const repo = repository();
    try {
      for (const locale of locales) repo.write(catalog, locale);
      repo.commit('catalogs');
      const check = repo.cli('check', '--base=origin/no-such-branch');
      expect(check.status).not.toBe(0);
      expect(check.stderr).toContain('unknown revision: origin/no-such-branch');
    } finally {
      repo.cleanup();
    }
  });
});

describe('the registered merge driver in a real repository', () => {
  const catalog = catalogPath('en');
  const base = { common: { save: 'Save', cancel: 'Cancel' }, nav: { home: 'Home' } };

  test('two branches that add keys next to the same key merge cleanly and keep both orders', () => {
    const repo = repository();
    try {
      repo.write(base);
      repo.commit('base');
      repo.git('checkout', '-q', '-b', 'feature');
      repo.write({
        common: { save: 'Save', saveAll: 'Save all', cancel: 'Cancel' },
        nav: base.nav,
      });
      repo.commit('feature');
      repo.git('checkout', '-q', 'main');
      repo.write({ common: { save: 'Save', saveAs: 'Save as', cancel: 'Cancel' }, nav: base.nav });
      repo.commit('main');

      const merge = repo.git('merge', '--no-edit', 'feature');
      expect(merge.status).toBe(0);
      expect(repo.read()).toBe(
        serializeCatalog({
          common: { save: 'Save', saveAll: 'Save all', saveAs: 'Save as', cancel: 'Cancel' },
          nav: { home: 'Home' },
        }),
      );
    } finally {
      repo.cleanup();
    }
  });

  test('a cherry-pick uses the driver too', () => {
    const repo = repository();
    try {
      repo.write(base);
      repo.commit('base');
      repo.git('checkout', '-q', '-b', 'feature');
      repo.write({ ...base, nav: { home: 'Home', agents: 'Agents' } });
      repo.commit('feature');
      repo.git('checkout', '-q', 'main');
      repo.write({ ...base, nav: { home: 'Home', settings: 'Settings' } });
      repo.commit('main');

      expect(repo.git('cherry-pick', 'feature').status).toBe(0);
      expect(Object.keys(JSON.parse(repo.read()).nav)).toEqual(['home', 'agents', 'settings']);
    } finally {
      repo.cleanup();
    }
  });

  test('a key changed two ways stops the merge with markers around that key only', () => {
    const repo = repository();
    try {
      repo.write(base);
      repo.commit('base');
      repo.git('checkout', '-q', '-b', 'feature');
      repo.write({
        common: { save: 'Store', cancel: 'Cancel' },
        nav: { home: 'Home', agents: 'Agents' },
      });
      repo.commit('feature');
      repo.git('checkout', '-q', 'main');
      repo.write({ common: { save: 'Keep', cancel: 'Cancel' }, nav: base.nav });
      repo.commit('main');

      const merge = repo.git('merge', '--no-edit', 'feature');
      expect(merge.status).not.toBe(0);
      expect(repo.git('diff', '--name-only', '--diff-filter=U').stdout.trim()).toBe(catalog);
      const text = repo.read();
      expect(text.match(/^<<<<<<< /gm)).toHaveLength(1);
      // Git before 2.44 passes no conflict labels; the driver then uses its own.
      expect(text).toMatch(
        /^<<<<<<< \S+\n {4}"save": "Keep",\n=======\n {4}"save": "Store",\n>>>>>>> \S+$/m,
      );
      // Everything else merged: the feature's new key is already in place.
      expect(text).toContain('"agents": "Agents"');
    } finally {
      repo.cleanup();
    }
  });

  // An old checkout, or a GUI client without node on PATH: git's own text
  // merge runs. The result is either clean or marked — never a file that
  // silently holds only our side.
  test('without the driver script, git falls back to its text merge', () => {
    const repo = repository({ withDriverScript: false });
    try {
      repo.write(base);
      repo.commit('base');
      repo.git('checkout', '-q', '-b', 'feature');
      repo.write({ common: { save: 'Store', cancel: 'Cancel' }, nav: base.nav });
      repo.commit('feature');
      repo.git('checkout', '-q', 'main');
      repo.write({ common: { save: 'Keep', cancel: 'Cancel' }, nav: base.nav });
      repo.commit('main');

      expect(repo.git('merge', '--no-edit', 'feature').status).not.toBe(0);
      expect(repo.read()).toMatch(
        /^<<<<<<< \S+\n {4}"save": "Keep",\n=======\n {4}"save": "Store",\n>>>>>>> \S+$/m,
      );
    } finally {
      repo.cleanup();
    }
  });
});
