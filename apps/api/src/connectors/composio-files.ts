/**
 * File inputs for Composio tools.
 *
 * A Composio tool declares a file input as a `file_uploadable` object
 * `{ name, mimetype, s3key }`, and the `s3key` must name a file in Composio's
 * storage for this Composio project. An agent has no such key, so it passes a
 * public http(s) URL instead: either the URL itself, or the object with the
 * URL as `s3key` or `url`. This module reads that URL through the egress
 * guard, uploads the bytes to Composio, and puts Composio's reference in its
 * place. A reference that already holds a non-URL `s3key` passes unchanged.
 */
import { safeEgressFetch } from '../shared/ssrf-guard';

export interface FileRef {
  name: string;
  mimetype: string;
  s3key: string;
}

/** Upload the file at `url`. `hint` carries the name and mimetype the agent gave. */
export type FileUpload = (url: string, hint: { name?: string; mimetype?: string }) => Promise<FileRef>;

type Schema = Record<string, unknown> & {
  file_uploadable?: boolean;
  properties?: Record<string, Schema>;
  items?: Schema;
  anyOf?: Schema[];
  oneOf?: Schema[];
};

/** Composio's own cap on a file read from a URL (`MAX_URL_UPLOAD_SIZE_BYTES`). */
const MAX_FILE_BYTES = 100 * 1024 * 1024;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function httpUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const { protocol } = new URL(value);
    return protocol === 'http:' || protocol === 'https:' ? value : null;
  } catch {
    return null;
  }
}

/** A refusal the caller can fix (bad URL, too large): answered as HTTP 400. */
const callerError = (message: string) => Object.assign(new Error(message), { status: 400 });

/**
 * Return `args` with every URL in a `file_uploadable` field replaced by the
 * uploaded file's reference. Throws `file upload failed for <field>: …`,
 * carrying the uploader's `status` when it has one.
 */
export async function uploadFileArgs(
  args: Record<string, unknown>,
  schema: Record<string, unknown> | null | undefined,
  upload: FileUpload,
): Promise<Record<string, unknown>> {
  if (!schema) return args;
  return (await walk(args, schema as Schema, '', upload)) as Record<string, unknown>;
}

async function walk(value: unknown, schema: Schema | undefined, field: string, upload: FileUpload): Promise<unknown> {
  if (!schema) return value;
  const variants = [...(schema.anyOf ?? []), ...(schema.oneOf ?? [])];
  if (variants.length > 0) {
    const variant = Array.isArray(value)
      ? variants.find((v) => v?.items)
      : (variants.find((v) => v?.file_uploadable) ?? variants.find((v) => v?.properties));
    return walk(value, variant, field, upload);
  }
  if (schema.file_uploadable) {
    const url = httpUrl(value) ?? (isObject(value) ? (httpUrl(value.s3key) ?? httpUrl(value.url)) : null);
    if (!url) return value;
    const hint = isObject(value)
      ? {
          ...(typeof value.name === 'string' && value.name ? { name: value.name } : {}),
          ...(typeof value.mimetype === 'string' && value.mimetype ? { mimetype: value.mimetype } : {}),
        }
      : {};
    try {
      return await upload(url, hint);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = (error as { status?: unknown })?.status;
      throw Object.assign(new Error(`file upload failed for ${field}: ${message}`), {
        ...(typeof status === 'number' ? { status } : {}),
      });
    }
  }
  if (Array.isArray(value) && schema.items) {
    return Promise.all(value.map((item, i) => walk(item, schema.items, `${field}[${i}]`, upload)));
  }
  if (isObject(value) && schema.properties) {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = await walk(entry, schema.properties[key], field ? `${field}.${key}` : key, upload);
    }
    return out;
  }
  return value;
}

/** The part of `composio.files` this module calls. */
export interface ComposioFilesLike {
  upload(input: { file: File; toolSlug: string; toolkitSlug: string }): Promise<FileRef>;
}

/**
 * Read `url` through the egress guard (public hosts only, every redirect
 * re-checked) and upload it to Composio for this tool.
 * ponytail: the file is held in memory (≤ 100 MB); stream it if large files become common.
 */
export function composioFileUpload(
  files: ComposioFilesLike,
  toolkit: string,
  toolSlug: string,
  fetchImpl: (url: string) => Promise<Response> = (url) => safeEgressFetch(url, { allowHttp: true }),
): FileUpload {
  return async (url, hint) => {
    const res = await fetchImpl(url).catch((error: unknown) => {
      throw callerError(`the URL could not be read (${error instanceof Error ? error.message : String(error)})`);
    });
    if (!res.ok) throw callerError(`the URL answered HTTP ${res.status}`);
    const tooLarge = callerError('the file is larger than 100 MB');
    if (Number(res.headers.get('content-length') ?? 0) > MAX_FILE_BYTES) throw tooLarge;
    const bytes = await res.arrayBuffer();
    if (bytes.byteLength > MAX_FILE_BYTES) throw tooLarge;
    const name = hint.name ?? (new URL(url).pathname.split('/').pop() || 'file');
    const type =
      hint.mimetype ?? (res.headers.get('content-type')?.split(';')[0]?.trim() || 'application/octet-stream');
    return files.upload({ file: new File([bytes], name, { type }), toolSlug, toolkitSlug: toolkit });
  };
}
