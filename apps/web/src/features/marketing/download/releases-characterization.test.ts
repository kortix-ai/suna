import { afterAll, afterEach, expect, spyOn, test } from 'bun:test';
import { getLatestRelease, getDesktopRelease, getLatestCaptureRelease } from './releases';

const fetchSpy = spyOn(globalThis, 'fetch');
const timeoutSpy = spyOn(AbortSignal, 'timeout');
afterAll(() => { fetchSpy.mockRestore(); timeoutSpy.mockRestore(); });
afterEach(() => { fetchSpy.mockReset(); timeoutSpy.mockClear(); });
const asset = { name: 'KortixCapture-x64.msi', browser_download_url: 'synthetic/installer' };
const readers = [getLatestRelease, () => getDesktopRelease('dev'), getLatestCaptureRelease];

for (const [index, read] of readers.entries()) {
  test(`reader ${index} filters assets and preserves request options`, async () => {
    const release = { tag_name: 'v1.2.3', assets: [{}, { name: 'missing-url' }, asset] };
    fetchSpy.mockResolvedValue(Response.json(index === 2 ? [release] : release));
    expect(await read()).toEqual({ version: index === 1 ? 'v1.2.3' : '1.2.3', assets: [{ name: asset.name, url: asset.browser_download_url, size: 0 }] });
    expect(fetchSpy.mock.calls[0]?.[1]).toMatchObject({ headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'kortix-download' }, next: { revalidate: 600 } });
    expect(fetchSpy.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
    expect(timeoutSpy).toHaveBeenCalledWith(3_000);
  });
  for (const payload of [{}, { assets: [] }, { assets: {} }, { assets: [null] }]) {
    test(`reader ${index} degrades for ${JSON.stringify(payload)}`, async () => {
      fetchSpy.mockResolvedValue(Response.json(index === 2 ? [{ tag_name: 'v1.2.3', ...payload }] : payload));
      expect(await read()).toBeNull();
    });
  }
  for (const failure of ['http', 'json', 'network']) {
    test(`reader ${index} degrades after ${failure} failure`, async () => {
      if (failure === 'network') fetchSpy.mockRejectedValue(new Error('synthetic network failure'));
      else fetchSpy.mockResolvedValue(new Response(failure === 'json' ? '{' : '', { status: failure === 'http' ? 503 : 200 }));
      expect(await read()).toBeNull();
    });
  }
}

test('latest missing tag and tagged name/tag/request fallback remain distinct', async () => {
  fetchSpy.mockResolvedValue(Response.json({ assets: [asset] }));
  expect((await getLatestRelease())?.version).toBe('');
  fetchSpy.mockResolvedValue(Response.json({ assets: [asset] }));
  expect((await getDesktopRelease('dev'))?.version).toBe('desktop-dev-latest');
  fetchSpy.mockResolvedValue(Response.json({ name: '', tag_name: 'v1.2.3', assets: [asset] }));
  expect((await getDesktopRelease('dev'))?.version).toBe('');
});
