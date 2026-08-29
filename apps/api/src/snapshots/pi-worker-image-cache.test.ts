import { describe, expect, test } from 'bun:test';

async function builderSource(): Promise<string> {
  return Bun.file(new URL('./builder.ts', import.meta.url)).text();
}

// ensurePiWorkerImage caches a verified-active snapshot result: the name is
// content-hashed (immutable) and the reaper only deletes SUPERSEDED hashes,
// so re-checking the provider every session create bought nothing and cost a
// ~310 ms state round trip on the cold boot path (measured on dev
// 2026-08-27). Behavioral coverage would need to mock the providers barrel,
// which breaks sibling suites when co-run — so the shape is pinned instead.
describe('pi worker image ready-cache', () => {
  test('the cache is consulted before the single-flight map and written after prepare', async () => {
    const source = await builderSource();
    const fn = source.indexOf('export async function ensurePiWorkerImage');
    expect(fn).toBeGreaterThan(-1);
    const lookup = source.indexOf('piWorkerImageReady.get(buildKey)', fn);
    const singleFlight = source.indexOf('piWorkerImageBuilds.get(buildKey)', fn);
    const write = source.indexOf('piWorkerImageReady.set(buildKey', fn);
    const fnEnd = source.indexOf('export async function ensureMetaSandboxImage', fn);
    expect(lookup).toBeGreaterThan(fn);
    expect(singleFlight).toBeGreaterThan(lookup);
    expect(write).toBeGreaterThan(singleFlight);
    expect(write).toBeLessThan(fnEnd);
    // TTL-guarded read, and only a PREPARED result is ever cached.
    const readBlock = source.slice(lookup, singleFlight);
    expect(readBlock).toContain('PI_WORKER_IMAGE_READY_TTL_MS');
    const writeBlock = source.slice(singleFlight, write);
    expect(writeBlock).toContain('prepareSnapshotForReuse(provider, snapshotName, result');
  });

  test('a fresh build is never served from the ready-cache path uninitialized', async () => {
    const source = await builderSource();
    const fn = source.indexOf('export async function ensurePiWorkerImage');
    const fnEnd = source.indexOf('export async function ensureMetaSandboxImage', fn);
    const body = source.slice(fn, fnEnd);
    // The cache read happens after provider-configured validation, so a
    // misconfigured provider still fails loudly instead of serving stale.
    expect(body.indexOf('isConfigured()')).toBeLessThan(body.indexOf('piWorkerImageReady.get'));
  });
});
