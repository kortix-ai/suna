export const MAX_PROMPT_UPLOAD_FILENAME_BYTES = 255 - 40;

export interface PromptFileReference {
  path: string;
  mime: string;
  filename: string;
  pendingId?: string;
}

export function isModelNativeAttachmentMime(mime: string): boolean {
  const normalized = mime.trim().toLowerCase();
  return normalized.startsWith('image/') || normalized === 'application/pdf';
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
