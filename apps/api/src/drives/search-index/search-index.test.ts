import { describe, expect, test } from 'bun:test';
import type { FolderGrant } from '../folders';
import { cutUtf8, extractText, INDEX_BODY_BYTES, indexReadBytes, isTextLike, mtimeDate, stripHtml } from './extract';
import { decodeCursor, encodeCursor, parseLimit, parseSearchQuery } from './query';
import { personReader, sessionReader } from './readers';

const enc = (text: string) => new TextEncoder().encode(text);

describe('text extraction', () => {
  test('reads text-like files by name; env files and keys stay name-only', () => {
    for (const p of ['/Company/plan.md', '/a/data.CSV', '/a/x.ts', '/a/Makefile', '/a/README', '/a/page.html']) expect(isTextLike(p)).toBe(true);
    for (const p of ['/a/photo.png', '/a/deck.pdf', '/a/.env', '/a/.env.local', '/a/server.pem', '/a/id_rsa', '/a/archive']) expect(isTextLike(p)).toBe(false);
  });

  test('cuts the body at 256 KiB on a character boundary and hashes the bytes read', () => {
    const big = 'é'.repeat(INDEX_BODY_BYTES); // 2 bytes each: twice the cap
    const out = extractText('/a.md', enc(big));
    expect(Buffer.byteLength(out.body, 'utf8')).toBe(INDEX_BODY_BYTES);
    expect(out.body.endsWith('é')).toBe(true);
    expect(out.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(cutUtf8('aé', 2)).toBe('a');
  });

  test('a read that cut a character in half drops it; a NUL in the first 8 KiB marks the file binary', () => {
    const bytes = enc('hello é');
    expect(extractText('/a.txt', bytes.subarray(0, bytes.length - 1)).body).toBe('hello ');
    expect(extractText('/a.txt', new Uint8Array([104, 0, 105])).body).toBe('');
  });

  test('HTML loses scripts, styles, tags and entities; it is read up to 1 MiB before the cut', () => {
    const html = '<html><head><style>.x{}</style><script>var secret=1</script></head><body><h1>Q3 &amp; plans</h1><p>ship&nbsp;it</p></body></html>';
    expect(stripHtml(html)).toBe('Q3 & plans ship it');
    expect(extractText('/a.html', enc(html)).body).toBe('Q3 & plans ship it');
    expect(indexReadBytes('/a.html')).toBe(1024 * 1024);
    expect(indexReadBytes('/a.md')).toBe(INDEX_BODY_BYTES);
  });

  test('mtime in seconds or milliseconds', () => {
    expect(mtimeDate(1_700_000_000)?.toISOString()).toBe('2023-11-14T22:13:20.000Z');
    expect(mtimeDate(1_700_000_000_000)?.toISOString()).toBe('2023-11-14T22:13:20.000Z');
    expect(mtimeDate(0)).toBeNull();
  });
});

describe('query parsing', () => {
  test('words become required prefix terms; only letters and digits reach the tsquery', () => {
    expect(parseSearchQuery('  Q3 budget-plan ')).toEqual({ text: 'Q3 budget-plan', tsquery: 'q3:* & budget:* & plan:*', namePattern: '%Q3 budget-plan%' });
    expect(parseSearchQuery("xy' | !yz:* & (z)")?.tsquery).toBe('xy:* & yz:* & z');
    expect(parseSearchQuery('100%_\\')?.namePattern).toBe('%100\\%\\_\\\\%');
    expect(parseSearchQuery('***')?.tsquery).toBe('');
  });

  test('an empty or over-long query is refused', () => {
    expect(parseSearchQuery('')).toBeNull();
    expect(parseSearchQuery('   ')).toBeNull();
    expect(parseSearchQuery(undefined)).toBeNull();
    expect(parseSearchQuery('a'.repeat(201))).toBeNull();
  });

  test('limit and cursor', () => {
    expect(parseLimit(undefined)).toBe(20);
    expect(parseLimit('500')).toBe(100);
    expect(parseLimit('0')).toBe(1);
    expect(parseLimit('2.5')).toBeNull();
    expect(decodeCursor(encodeCursor(40))).toBe(40);
    expect(decodeCursor(undefined)).toBe(0);
    expect(decodeCursor('not-a-cursor')).toBeNull();
    expect(decodeCursor(Buffer.from('{"o":-1}').toString('base64url'))).toBeNull();
  });
});

describe('who reads what', () => {
  const ANA = 'u-ana';
  const BEN = 'u-ben';
  const grants: FolderGrant[] = [
    { path: '/Users/ana', level: 'manage', principalType: 'user', principalId: ANA, source: 'system' },
    { path: '/Users/ben', level: 'manage', principalType: 'user', principalId: BEN, source: 'system' },
    { path: '/Users/ben/shared', level: 'read', principalType: 'user', principalId: ANA },
    { path: '/Sales', level: 'write', principalType: 'agent', principalId: 'sa-sales' },
    { path: '/Channels/s1', level: 'write', principalType: 'user', principalId: BEN, source: 'system' },
  ];
  const channels = new Set(['/Channels/s1']);

  test('a member reads their folder, what is shared with them and the shared Drives of agents they may use, nothing else', () => {
    const r = personReader(grants, { userId: ANA, agentIds: new Set(['sa-sales']), privateChannelFolders: channels });
    expect(r.access('/Users/ana/notes.md')).toBe('manage');
    expect(r.access('/Users/ben/shared/q3.md')).toBe('read');
    expect(r.access('/Sales/plan.md')).toBe('write');
    expect(r.access('/Company/plan.md')).toBe('none');
    expect(r.access('/Users/ben/diary.md')).toBe('none');
    expect(r.access('/Channels/s1/x.md')).toBe('none');
    expect(r.access('/Team/x.md')).toBe('none');
    expect(r.include?.sort()).toEqual(['/Sales', '/Users/ana', '/Users/ben/shared']);
    // ben's folder holds a share with ana, so SQL keeps it and the per-path rule decides.
    expect(r.exclude).toEqual(['/Channels/s1']);
  });

  test('a project admin reaches every folder but people’s and private channels’ they hold no grant in', () => {
    const r = personReader(grants, { userId: ANA, admin: true, privateChannelFolders: channels });
    expect(r.include).toBeNull();
    expect(r.access('/Team/x.md')).toBe('manage');
    expect(r.access('/Users/ben/diary.md')).toBe('none');
    expect(r.exclude).toEqual(['/Channels/s1']);
  });

  test('a session reads exactly its mountable folders, at its mount access', () => {
    const r = sessionReader([
      { path: '/Users/ana', readOnly: false },
      { path: '/Company', readOnly: true },
      { path: '/Company/ops', readOnly: false },
    ]);
    expect(r.include).toEqual(['/Users/ana', '/Company', '/Company/ops']);
    expect(r.access('/Company/plan.md')).toBe('read');
    expect(r.access('/Company/ops/run.md')).toBe('write');
    expect(r.access('/Users/ana/x')).toBe('write');
    expect(r.access('/Team/x.md')).toBe('none');
    expect(r.access('/Users/anabel/x')).toBe('none');
    expect(sessionReader([]).include).toEqual([]);
  });
});
