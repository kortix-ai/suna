/**
 * Object URLs for data-URL attachments — decoded ONCE per part, off the
 * transcript's hot path.
 *
 * A composer attachment rides the first message as a `file` part whose `url`
 * is a `data:image/…;base64,…` string (uploaded-file-refs.ts, up to 9 MiB).
 * That string is the part's persisted form: the server, the disk cache and
 * the sync store all hold it, and every frame re-propagates the part through
 * `groupMessagesIntoTurns` → `constructTimelineRows` → the row props. None of
 * those READ the url (rows key by ids; `timelineRowsEqual` compares keys),
 * but the render used to hand the multi-MB string straight to `<img src>`,
 * so React diffed it on every reconcile and the browser re-parsed it on
 * every mount.
 *
 * This module is the one place the bytes are decoded: `attachmentDisplaySrc`
 * turns the data URL into a `Blob` object URL the first time a part is
 * rendered and hands the same short `blob:` URL back for the life of the
 * session. The data URL stays where it was — only the render reads the
 * object URL.
 *
 * Lifetime: a `SessionChat` retains its session on mount and releases it on
 * unmount (refcounted, so a second view of the same session — a sub-session
 * modal, a hidden tab — keeps the URLs alive). The last release revokes the
 * session's URLs. A part whose data URL changed (re-sent, re-minted) gets a
 * fresh object URL and the old one is revoked on the spot.
 *
 * Pure-ish and DOM-free: `URL.createObjectURL` / `Blob` / `atob` exist in Bun
 * as well as every browser, so the cache is unit-tested without a DOM.
 */

interface AttachmentPartLike {
  id: string;
  sessionID?: string;
  url: string;
}

interface CacheEntry {
  objectUrl: string;
  dataUrl: string;
  sessionID: string | undefined;
  blob: Blob;
}

const entries = new Map<string, CacheEntry>();
const retained = new Map<string, number>();

let createObjectUrl: (blob: Blob) => string = (blob) => URL.createObjectURL(blob);
let revokeObjectUrl: (url: string) => void = (url) => URL.revokeObjectURL(url);

const DATA_URL_BASE64 = /^data:([^;,]+)?((?:;[^;,]+)*);base64,/i;

/** Decode a `data:<mime>;base64,<payload>` URL into a Blob; `null` when the
 *  URL is not a base64 data URL or the payload does not decode. */
export function decodeBase64DataUrl(dataUrl: string): Blob | null {
  const match = DATA_URL_BASE64.exec(dataUrl);
  if (!match) return null;
  const mime = match[1] || 'application/octet-stream';
  const payload = dataUrl.slice(match[0].length);
  // `atob` throws on a payload that is not base64. The catch is the ONLY
  // sane response — the caller renders the data URL itself, as before.
  try {
    const binary = atob(payload);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: mime });
  } catch {
    return null;
  }
}

/**
 * The `src` to RENDER for a file part: its `url`, unless that is a base64
 * data URL — then a `blob:` object URL decoded once for this part id.
 */
export function attachmentDisplaySrc(part: AttachmentPartLike): string {
  const { id, url } = part;
  if (!url || !url.startsWith('data:')) return url;
  const cached = entries.get(id);
  if (cached && cached.dataUrl === url) return cached.objectUrl;
  const blob = decodeBase64DataUrl(url);
  if (!blob) return url;
  if (cached) revokeObjectUrl(cached.objectUrl);
  const objectUrl = createObjectUrl(blob);
  entries.set(id, { objectUrl, dataUrl: url, sessionID: part.sessionID, blob });
  return objectUrl;
}

/** A chat holds its session's object URLs for as long as it is mounted. */
export function retainAttachmentObjectUrls(sessionID: string): void {
  retained.set(sessionID, (retained.get(sessionID) ?? 0) + 1);
}

/** The last holder's release revokes every object URL of that session. */
export function releaseAttachmentObjectUrls(sessionID: string): void {
  const count = retained.get(sessionID);
  if (count === undefined) return;
  if (count > 1) {
    retained.set(sessionID, count - 1);
    return;
  }
  retained.delete(sessionID);
  for (const [id, entry] of entries) {
    if (entry.sessionID !== sessionID) continue;
    revokeObjectUrl(entry.objectUrl);
    entries.delete(id);
  }
}

export const __testing = {
  reset(): void {
    for (const entry of entries.values()) revokeObjectUrl(entry.objectUrl);
    entries.clear();
    retained.clear();
    createObjectUrl = (blob) => URL.createObjectURL(blob);
    revokeObjectUrl = (url) => URL.revokeObjectURL(url);
  },
  spyCreate(onCreate: (url: string) => void): void {
    createObjectUrl = (blob) => {
      const url = URL.createObjectURL(blob);
      onCreate(url);
      return url;
    };
  },
  spyRevoke(onRevoke: (url: string) => void): void {
    revokeObjectUrl = (url) => {
      onRevoke(url);
      URL.revokeObjectURL(url);
    };
  },
  blobFor(partId: string): Blob | undefined {
    return entries.get(partId)?.blob;
  },
  size(): number {
    return entries.size;
  },
};
