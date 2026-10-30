import { expect, test } from 'bun:test';
import { createArtifactScreenshotStore, screenshotObjectKey } from './comment-screenshot-storage';

const project = '11111111-1111-4111-8111-111111111111';
const comment = '22222222-2222-4222-8222-222222222222';
const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const key = `${project}/artifact-comments/${comment}.png`;
function fixture() {
  const calls: unknown[][] = [];
  const bucket = {
    upload: async (...args: unknown[]) => { calls.push(['upload', ...args]); return { error: null }; },
    createSignedUrl: async (...args: unknown[]) => { calls.push(['sign', ...args]); return { data: { signedUrl: 'https://storage.example/signed?token=private' }, error: null }; },
    remove: async (...args: unknown[]) => { calls.push(['remove', ...args]); return { error: null }; },
  };
  const store = createArtifactScreenshotStore({ from: (name: string) => { calls.push(['bucket', name]); return bucket; } }, 'https://storage.example', async () => new Response(bytes, { headers: { 'content-type': 'image/png' } }));
  return { store, calls, bucket };
}

test('objects stay in the existing private bucket under the exact project/comment prefix', async () => {
  const { store, calls } = fixture();
  expect(screenshotObjectKey(project, comment, 'png')).toBe(key);
  expect(() => screenshotObjectKey('../other', comment, 'png')).toThrow();
  await store.put(key, { bytes, mime: 'image/png' });
  expect(calls[0]).toEqual(['bucket', 'session-attachments']);
  expect(calls[1]).toEqual(['upload', key, bytes, { contentType: 'image/png', upsert: false, cacheControl: '0' }]);
});

test('each protected read signs internally and returns bytes without exposing the bearer URL', async () => {
  const { store, calls } = fixture();
  expect(await store.read(key)).toEqual({ bytes, mime: 'image/png' });
  expect(calls).toContainEqual(['sign', key, 60]);
  expect(await store.read(key)).toEqual({ bytes, mime: 'image/png' });
  expect(calls.filter(entry => entry[0] === 'sign')).toHaveLength(2);
});

test('failed deletion remains an error for durable retry, while a missing object is idempotent', async () => {
  const { store, bucket } = fixture();
  bucket.remove = async () => ({ error: { statusCode: '503', message: 'private-provider-error' } }) as any;
  await expect(store.remove(key)).rejects.toMatchObject({ status: 503, code: 'screenshot_storage_unavailable' });
  bucket.remove = async () => ({ error: { statusCode: '404' } }) as any;
  await expect(store.remove(key)).resolves.toBeUndefined();
});

test('signed downloads cannot redirect or exceed the decoded screenshot cap', async () => {
  const { bucket } = fixture();
  const storage = { from: () => bucket };
  let options: RequestInit | undefined;
  const redirect = createArtifactScreenshotStore(storage, 'https://storage.example', async (_url, init) => { options = init; return new Response(null, { status: 302, headers: { location: 'https://other.example/private' } }); });
  await expect(redirect.read(key)).rejects.toMatchObject({ status: 503 });
  expect(options?.redirect).toBe('error');
  const large = createArtifactScreenshotStore(storage, 'https://storage.example', async () => new Response(new Uint8Array(2 * 1024 * 1024 + 1)));
  await expect(large.read(key)).rejects.toMatchObject({ status: 503 });
  bucket.createSignedUrl = async () => ({ data: { signedUrl: 'https://other.example/private' }, error: null });
  await expect(createArtifactScreenshotStore(storage, 'https://storage.example').read(key)).rejects.toMatchObject({ status: 503 });
});
