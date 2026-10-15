/**
 * An in-memory `session-attachments` bucket in place of `getSupabase().storage`.
 * It answers as Supabase Storage does: an upload over an existing key is a 409,
 * a missing object is a 404, and `list` returns ONE level under the prefix.
 */
export function fakeSessionStorage() {
  const objects = new Map<string, Blob>();
  /** Every upload call, in order, existing keys included. */
  const uploads: string[] = [];
  /** The next `failDownloads.next` downloads answer a 500. */
  const failDownloads = { next: 0 };
  /** Each upload waits `slowUploads.ms` first (a slow Storage). */
  const slowUploads = { ms: 0 };
  const storage = {
    from(bucket: string) {
      if (bucket !== 'session-attachments') throw new Error(`unexpected bucket ${bucket}`);
      return {
        async upload(key: string, bytes: Uint8Array, options: { contentType: string }) {
          uploads.push(key);
          if (slowUploads.ms > 0) await Bun.sleep(slowUploads.ms);
          if (objects.has(key)) return { data: null, error: { statusCode: '409', message: 'The resource already exists' } };
          objects.set(key, new Blob([Uint8Array.from(bytes)], { type: options.contentType }));
          return { data: { path: key }, error: null };
        },
        async download(key: string) {
          if (failDownloads.next > 0) {
            failDownloads.next--;
            return { data: null, error: { statusCode: '500', message: 'Storage unavailable' } };
          }
          const blob = objects.get(key);
          return blob ? { data: blob, error: null } : { data: null, error: { statusCode: '404', message: 'Object not found' } };
        },
        async list(prefix: string) {
          const names = [...objects.keys()].filter((k) => k.startsWith(`${prefix}/`)).map((k) => k.slice(prefix.length + 1).split('/')[0]!);
          return { data: [...new Set(names)].map((name) => ({ name })), error: null };
        },
        async remove(keys: string[]) {
          for (const key of keys) objects.delete(key);
          return { data: [], error: null };
        },
      };
    },
  };
  return { objects, uploads, failDownloads, slowUploads, storage };
}
