export const MAX_PROMPT_UPLOAD_FILENAME_BYTES = 255 - 40;

export interface PromptFileReference {
  path: string;
  mime: string;
  filename: string;
  pendingId?: string;
}

/**
 * The attachment MIME types a model accepts INLINE, as base64 in the prompt.
 *
 * An allowlist, not `image/*`. OpenCode decodes every `image/` part as a
 * raster before it writes the message; a type it cannot decode throws
 * `ImageDecodeError` inside `prompt_async`, and OpenCode then persists NO
 * message — the prompt text and every sibling attachment vanish with it. The
 * inbox meanwhile records `delivered`, because `prompt_async` answers 204 for
 * *accepted*, not *processed*. One undecodable file therefore deletes the
 * whole turn, silently, on both ends.
 *
 * `image/svg+xml`, `image/bmp`, `image/x-icon`, `image/heic` and `image/heif`
 * are all in the composer's upload allowlist (`constants/upload-limits.ts`)
 * and none of them are decodable here. They are not "unsupported": everything
 * outside this list is materialized into `/workspace/uploads/...` and handed
 * to the agent as a `<file>` reference, which for an SVG (XML text the agent
 * can read directly) is the better of the two paths anyway.
 *
 * Incident: 2026-09-04 — two SVG logos plus a PDF, sent from the session
 * composer. Runtime logged `ImageDecodeError: Image could not be decoded`,
 * the message was never created, and the transcript rendered a lone spinner.
 */
const MODEL_NATIVE_ATTACHMENT_MIMES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'application/pdf',
]);

export function isModelNativeAttachmentMime(mime: string): boolean {
  // `Content-Type` parameters ride along on real uploads
  // (`image/png; charset=binary`); the type alone decides.
  const normalized = mime.split(';')[0]!.trim().toLowerCase();
  return MODEL_NATIVE_ATTACHMENT_MIMES.has(normalized);
}

const UNSAFE_FILENAME_CHARS = new RegExp('[/\\\\\\u0000-\\u001f\\u007f-\\u009f]', 'g');
const UTF8 = new TextEncoder();

function byteLength(value: string): number {
  return UTF8.encode(value).length;
}

function truncateBytes(value: string, max: number): string {
  let output = '';
  let bytes = 0;
  for (const character of value) {
    const size = byteLength(character);
    if (bytes + size > max) break;
    output += character;
    bytes += size;
  }
  return output;
}

function splitExtension(name: string): [string, string] {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || byteLength(name.slice(dot)) > 32) return [name, ''];
  return [name.slice(0, dot), name.slice(dot)];
}

export function sanitizePromptUploadFilename(name: string): string {
  const sanitized = name.replace(UNSAFE_FILENAME_CHARS, '_').trim();
  const safe = !sanitized || sanitized === '.' || sanitized === '..' ? 'upload' : sanitized;
  if (byteLength(safe) <= MAX_PROMPT_UPLOAD_FILENAME_BYTES) return safe;
  const [stem, extension] = splitExtension(safe);
  const truncated = truncateBytes(
    stem,
    MAX_PROMPT_UPLOAD_FILENAME_BYTES - byteLength(extension),
  );
  return truncated ? `${truncated}${extension}` : `upload${extension}`;
}

function xmlAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function promptFileReferenceXml(input: PromptFileReference): string {
  const pending = input.pendingId
    ? ` pending="${xmlAttribute(input.pendingId)}"`
    : '';
  return `<file path="${xmlAttribute(input.path)}" mime="${xmlAttribute(input.mime)}" filename="${xmlAttribute(input.filename)}"${pending}>\nThis file has been uploaded and is available at the path above.\n</file>`;
}
