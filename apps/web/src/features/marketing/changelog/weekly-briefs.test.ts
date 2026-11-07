import { describe, expect, mock, test } from 'bun:test';

mock.module('server-only', () => ({}));
const { readWeeklyBriefs } = await import('./weekly-briefs');

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** A fake GitHub: the ref, then briefs.json at that commit. */
function github(file: unknown, opts: { refStatus?: number; fileStatus?: number } = {}) {
  const urls: string[] = [];
  const impl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    urls.push(url);
    if (url.endsWith('/git/ref/kortix/changelog-weekly')) {
      return opts.refStatus ? json({ message: 'Not Found' }, opts.refStatus) : json({ object: { sha: 'c0ffee' } });
    }
    if (url.endsWith('/contents/briefs.json?ref=c0ffee')) return json(file, opts.fileStatus ?? 200);
    throw new Error(`unexpected ${url}`);
  }) as typeof fetch;
  return { impl, urls };
}

describe('readWeeklyBriefs', () => {
  test('reads each week\'s highlight lines from briefs.json at the ref\'s commit', async () => {
    const g = github({
      version: 1,
      weeks: {
        '2026-W42': { highlights: [{ text: ' One credits plan for every account ', tags: ['v0.14.0'] }, { text: 'Enterprise SSO', tags: ['v0.13.57'] }] },
        '2026-W41': { highlights: [] },
      },
    });
    expect(await readWeeklyBriefs(g.impl)).toEqual({ '2026-W42': { highlights: ['One credits plan for every account', 'Enterprise SSO'], media: undefined } });
    expect(g.urls).toEqual([
      'https://api.github.com/repos/kortix-ai/CompanyOS/git/ref/kortix/changelog-weekly',
      'https://api.github.com/repos/kortix-ai/CompanyOS/contents/briefs.json?ref=c0ffee',
    ]);
  });

  test('retains old highlights alongside reviewed, draft and malformed media', async () => {
    const cover = {
      url: 'https://ke4pydspzeg0nm0o.public.blob.vercel-storage.com/changelog/cover.png',
      alt: 'Reviewed cover',
      width: 1200,
      height: 630,
    };
    const g = github({
      version: 1,
      weeks: {
        '2026-W42': { highlights: [{ text: 'Approved' }], media: { reviewed: true, cover } },
        '2026-W41': { highlights: [{ text: 'Draft' }], media: { reviewed: false, cover } },
        '2026-W40': {
          highlights: [{ text: 'Invalid' }],
          media: { reviewed: true, cover: { ...cover, alt: '' } },
        },
        '2026-W39': { highlights: 'junk' },
      },
    });
    expect(await readWeeklyBriefs(g.impl)).toEqual({
      '2026-W42': { highlights: ['Approved'], media: { cover } },
      '2026-W41': { highlights: ['Draft'], media: undefined },
      '2026-W40': { highlights: ['Invalid'], media: undefined },
    });
  });

  test('no ref yet (404) is no summaries, and briefs.json is never requested', async () => {
    const g = github({}, { refStatus: 404 });
    expect(await readWeeklyBriefs(g.impl)).toEqual({});
    expect(g.urls).toHaveLength(1);
  });

  test('a GitHub error, a network error, another version or junk is no summaries, never a throw', async () => {
    expect(await readWeeklyBriefs(github({}, { fileStatus: 500 }).impl)).toEqual({});
    expect(await readWeeklyBriefs((async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch)).toEqual({});
    expect(await readWeeklyBriefs(github({ version: 2, weeks: { '2026-W42': { highlights: [{ text: 'x' }] } } }).impl)).toEqual({});
    expect(await readWeeklyBriefs(github({ version: 1, weeks: { '2026-W42': { highlights: [{ text: 42 }, null] } } }).impl)).toEqual({});
  });
});
