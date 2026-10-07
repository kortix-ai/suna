/**
 * The indexed search and the children index must return exactly what the old
 * per-keystroke scans returned: same entries, same order. The old
 * implementations are copied here verbatim as the reference.
 */
import { describe, expect, test } from 'bun:test';

import { indexChildren, searchFileTree, type TreeSearchEntry, type TreeSearchResult } from './tree-search';

// ─── Reference: `searchFileTree` before the index ────────────────────────────
const refBasename = (path: string) => {
  const i = path.lastIndexOf('/');
  return i === -1 ? path : path.slice(i + 1);
};
const refParentOf = (path: string) => {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
};
function refRank(name: string, path: string, q: string): number {
  const n = name.toLowerCase();
  if (n.startsWith(q)) return 0;
  if (n.includes(q)) return 1;
  if (path.toLowerCase().includes(q)) return 2;
  return -1;
}
function refSearchFileTree(entries: readonly TreeSearchEntry[], query: string): TreeSearchResult[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const ranked: { result: TreeSearchResult; rank: number; depth: number }[] = [];
  const seenDirs = new Set<string>();
  for (const entry of entries) {
    const path = entry.path.replace(/^\/+/, '');
    if (!path) continue;
    const parts = path.split('/').filter(Boolean);
    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i).join('/');
      if (seenDirs.has(dir)) continue;
      seenDirs.add(dir);
      const name = parts[i - 1];
      const r = refRank(name, dir, q);
      if (r >= 0) {
        ranked.push({ result: { name, path: dir, parent: refParentOf(dir), type: 'directory' }, rank: r, depth: i });
      }
    }
    const name = refBasename(path);
    const r = refRank(name, path, q);
    if (r >= 0) {
      ranked.push({
        result: { name, path, parent: refParentOf(path), type: 'file', size: entry.size ?? undefined },
        rank: r,
        depth: parts.length,
      });
    }
  }
  ranked.sort((a, b) => {
    if (a.result.type !== b.result.type) return a.result.type === 'directory' ? -1 : 1;
    if (a.rank !== b.rank) return a.rank - b.rank;
    if (a.depth !== b.depth) return a.depth - b.depth;
    return a.result.path.localeCompare(b.result.path);
  });
  return ranked.map((r) => r.result);
}

// ─── Reference: `childrenOf` from FilesNavPage before the index ──────────────
function refChildrenOf<T extends { path: string }>(entries: T[], dir: string): { dirs: string[]; files: T[] } {
  const prefix = dir ? `${dir}/` : '';
  const dirSet = new Set<string>();
  const files: T[] = [];
  for (const e of entries) {
    if (dir && !e.path.startsWith(prefix)) continue;
    const rest = e.path.slice(prefix.length);
    if (!rest) continue;
    const slash = rest.indexOf('/');
    if (slash === -1) files.push(e);
    else dirSet.add(rest.slice(0, slash));
  }
  return { dirs: [...dirSet], files };
}

// ─── A synthetic tree of ~5,000 paths ────────────────────────────────────────
function makeRandom(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}
// `école` in NFD (e + combining acute): a different string that `localeCompare`
// calls equal to the NFC `école`, so two distinct paths share one `order`.
const NFD_ECOLE = 'e\u0301cole';
const SEGMENTS = [
  'src', 'Src', 'app', 'apps', 'App', 'lib', 'components', 'docs', 'README', 'readme', 'index', '.kortix',
  '.opencode', 'node_modules', 'a', 'B', 'résumé', 'Zeta', 'zeta', 'my-file', 'my_file', 'my file', 'v1.2',
  '10', '2', 'ÉCOLE', 'école', NFD_ECOLE, 'test', 'Test', 'tests', '_private', '-dash', 'x', 'Y',
];
const EXTENSIONS = ['', '.ts', '.tsx', '.md', '.json', '.TS', '.min.js', '.png'];

function makeTree(count: number): TreeSearchEntry[] {
  const rnd = makeRandom(42);
  const pick = <T,>(list: readonly T[]) => list[Math.floor(rnd() * list.length)];
  const entries: TreeSearchEntry[] = [];
  for (let i = 0; i < count; i++) {
    const depth = 1 + Math.floor(rnd() * 6);
    const parts: string[] = [];
    for (let d = 0; d < depth - 1; d++) parts.push(pick(SEGMENTS));
    parts.push(`${pick(SEGMENTS)}${rnd() < 0.3 ? i : ''}${pick(EXTENSIONS)}`);
    entries.push({ path: parts.join('/'), size: rnd() < 0.1 ? null : Math.floor(rnd() * 10_000) });
  }
  // Odd shapes the server could send: duplicates, a leading slash, an empty
  // segment, a trailing slash, an empty path, a bare slash.
  entries.push(
    { path: entries[10].path, size: 1 },
    { path: '/lead/slash.ts', size: 2 },
    { path: '//double/lead.ts' },
    { path: 'a//b.ts', size: 3 },
    { path: 'src/app/', size: 4 },
    { path: '', size: 5 },
    { path: '/', size: 6 },
    { path: 'src', size: 7 },
  );
  return entries;
}

const TREE = makeTree(5000);
const QUERIES = [
  'a', 'A', 'src', 'SRC/app', '.ts', '/', 'e', 'é', 'école', NFD_ECOLE, 'cole', 'x/y', '  App  ', 'zzz', '-', '_', '1', '10', 'index',
  'readme', 'my file', '.kortix', 'min.js', 'v1.', 'b.ts', 'lead', 'slash', '', '   ',
];

describe('searchFileTree matches the reference implementation', () => {
  test('the synthetic tree has about 5,000 entries', () => {
    expect(TREE.length).toBeGreaterThanOrEqual(5000);
  });

  test('the tree holds distinct paths that localeCompare calls equal', () => {
    expect(NFD_ECOLE).not.toBe('école');
    expect(NFD_ECOLE.localeCompare('école')).toBe(0);
    expect(TREE.some((e) => e.path.includes(NFD_ECOLE))).toBe(true);
    expect(TREE.some((e) => e.path.includes('école'))).toBe(true);
    const hits = searchFileTree(TREE, 'cole').map((r) => r.path);
    expect(hits.some((p) => p.includes(NFD_ECOLE))).toBe(true);
  });

  for (const query of QUERIES) {
    test(`query ${JSON.stringify(query)}`, () => {
      expect(searchFileTree(TREE, query)).toEqual(refSearchFileTree(TREE, query));
    });
  }

  test('the same entries searched twice return the same results', () => {
    expect(searchFileTree(TREE, 'app')).toEqual(searchFileTree(TREE, 'app'));
  });

  test('a new entries array is indexed again, not served from the old index', () => {
    const smaller = TREE.slice(0, 100);
    expect(searchFileTree(smaller, 'a')).toEqual(refSearchFileTree(smaller, 'a'));
  });
});

describe('indexChildren matches the reference childrenOf', () => {
  const index = indexChildren(TREE);
  const lookup = (dir: string) => index.get(dir) ?? { dirs: [], files: [] };

  test('every folder in the tree, and the root', () => {
    const dirs = new Set<string>(['']);
    for (const e of TREE) {
      for (let i = e.path.indexOf('/'); i !== -1; i = e.path.indexOf('/', i + 1)) dirs.add(e.path.slice(0, i));
    }
    expect(dirs.size).toBeGreaterThan(500);
    for (const dir of dirs) expect({ dir, ...lookup(dir) }).toEqual({ dir, ...refChildrenOf(TREE, dir) });
  });

  test('a folder that does not exist has no children', () => {
    for (const dir of ['nope', 'src/nope', 'src/', '/', 'a/', 'a//b.ts']) {
      expect({ dir, ...lookup(dir) }).toEqual({ dir, ...refChildrenOf(TREE, dir) });
    }
  });

  test('files keep their entry objects', () => {
    const root = lookup('');
    expect(root.files.every((f) => TREE.includes(f))).toBe(true);
  });
});
