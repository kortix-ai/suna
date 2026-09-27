/**
 * attachment-file — reads a picked `AttachedFile` off the device into a
 * `File` the SDK's `PromptAttachmentController` can upload
 * (`packages/sdk/src/core/attachments/prompt-attachments.ts`).
 */
import type { AttachedFile } from './attachments';

/**
 * Reads a local `file://` or `content://` URI into a React Native `Blob`
 * through React Native's `XMLHttpRequest` (`responseType = 'blob'`), which
 * hands the bytes to the native blob store without copying them through JS.
 *
 * Not `fetch(uri).blob()`: in Expo SDK 56 the global `fetch` is `expo/fetch`.
 * Its `blob()` calls the native `ExpoFetchModule.unstable_createBlobData`,
 * which an older Expo Go binary lacks, and it cannot read `content://` URIs.
 * Every picked photo then failed with "Couldn't attach …".
 */
export function readLocalBlob(
  uri: string,
  Xhr: typeof XMLHttpRequest = XMLHttpRequest,
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const xhr = new Xhr();
    xhr.onload = () => {
      // A local URI answers status 0 on Android; treat 0 and 2xx as success.
      if (xhr.status === 0 || (xhr.status >= 200 && xhr.status < 300)) resolve(xhr.response as Blob);
      else reject(new Error(`Couldn't read the file (HTTP ${xhr.status}).`));
    };
    xhr.onerror = () => reject(new Error("Couldn't read the file."));
    xhr.open('GET', uri);
    xhr.responseType = 'blob';
    xhr.send();
  });
}

/**
 * Reads the picked file's bytes and wraps them in a `File`. The picker's MIME
 * type wins; the blob's own type, then `application/octet-stream`, are the
 * fallbacks. Throws when the read comes back empty — a stale or revoked URI.
 */
export async function toUploadFile(
  f: AttachedFile,
  readBlob: (uri: string) => Promise<Blob> = readLocalBlob,
): Promise<File> {
  const blob = await readBlob(f.uri);
  if (!blob || blob.size === 0) throw new Error(`Couldn't read ${f.name}.`);
  return new File([blob], f.name, { type: f.mimeType || blob.type || 'application/octet-stream' });
}
