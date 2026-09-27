/**
 * Attachment handoff for connector calls, shared by `kortix connectors call
 * --attach` and the MCP `attachment_files` argument.
 *
 * File bytes never enter the model context or the call arguments. Each local
 * file is uploaded raw to the gateway's attachment staging route, and an
 * attachment id comes back. The call arguments carry the reference value
 * `{ "$kortix_attachment": "<attachment_id>" }`, which the gateway replaces
 * server-side: as an `attachments[]` element it becomes the provider's native
 * item (Microsoft Graph fileAttachment, SendGrid, Postmark, …); in a string
 * field it becomes the file's base64. The native Email channel receives a
 * signed URL instead.
 */
import { constants } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import { basename, extname, isAbsolute, relative, resolve, sep } from 'node:path';

import type { ConnectorClient } from './gateway.ts';

const MAX_ATTACHMENT_FILES = 20;
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const DEFAULT_ATTACHMENT_ROOTS = ['output', 'artifacts', 'reports', 'deliverables'];

const ATTACHMENT_CONTENT_TYPES: Record<string, string> = {
  '.csv': 'text/csv',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.json': 'application/json',
  '.md': 'text/markdown',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.txt': 'text/plain',
  '.webp': 'image/webp',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.zip': 'application/zip',
};

interface LocalAttachmentFile {
  path: string;
  filename?: string;
  content_type?: string;
  content_disposition?: 'attachment' | 'inline';
  content_id?: string;
}

export const ATTACHMENT_REF_KEY = '$kortix_attachment';

/** The call-args value the gateway replaces with the staged file. */
export function attachmentRef(attachmentId: string): Record<string, string> {
  return { [ATTACHMENT_REF_KEY]: attachmentId };
}

export interface UploadedAttachment {
  filename: string;
  content_type: string;
  content_disposition: 'attachment' | 'inline';
  content_id?: string;
  attachment_id: string;
}

function isWithinRoot(path: string, root: string): boolean {
  const offset = relative(root, path);
  return offset !== '' && !offset.startsWith(`..${sep}`) && offset !== '..' && !isAbsolute(offset);
}

function localAttachment(value: unknown, index: number): LocalAttachmentFile {
  const row = asRecord(value);
  const path = stringField(row, 'path').trim();
  if (!path) throw new Error(`attachment_files[${index}].path is required`);
  const disposition = row.content_disposition;
  if (disposition !== undefined && disposition !== 'attachment' && disposition !== 'inline') {
    throw new Error(
      `attachment_files[${index}].content_disposition must be "attachment" or "inline"`,
    );
  }
  return {
    path,
    ...(stringField(row, 'filename').trim()
      ? { filename: stringField(row, 'filename').trim() }
      : {}),
    ...(stringField(row, 'content_type').trim()
      ? { content_type: stringField(row, 'content_type').trim() }
      : {}),
    ...(disposition ? { content_disposition: disposition } : {}),
    ...(stringField(row, 'content_id').trim()
      ? { content_id: stringField(row, 'content_id').trim() }
      : {}),
  };
}

export async function uploadAttachmentFiles(
  value: unknown,
  connector: Pick<ConnectorClient, 'uploadAttachment'>,
  options: {
    workspaceRoot?: string;
    maxBytes?: number;
    /** Connector slug the files are for; the server checks the caller may use it. */
    connector?: string;
    afterOpen?: (path: string, index: number) => Promise<void>;
  } = {},
): Promise<UploadedAttachment[]> {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('attachment_files must be a non-empty array');
  }
  if (value.length > MAX_ATTACHMENT_FILES) {
    throw new Error(`attachment_files supports at most ${MAX_ATTACHMENT_FILES} files`);
  }

  const workspaceRoot = await realpath(
    options.workspaceRoot ?? process.env.KORTIX_INTERNAL_WORKSPACE_ROOT ?? '/workspace',
  );
  const allowedRoots = DEFAULT_ATTACHMENT_ROOTS.map((name) => resolve(workspaceRoot, name));
  const maxBytes = options.maxBytes ?? MAX_ATTACHMENT_BYTES;
  let totalBytes = 0;
  const uploaded: UploadedAttachment[] = [];

  for (let index = 0; index < value.length; index++) {
    const item = localAttachment(value[index], index);
    if (!isAbsolute(item.path)) {
      throw new Error(`attachment_files[${index}].path must be absolute`);
    }
    const file = await open(item.path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(
      (error: unknown) => {
        if (asRecord(error).code === 'ELOOP') {
          throw new Error(`attachment_files[${index}].path must not be a symbolic link`);
        }
        throw error;
      },
    );
    try {
      await options.afterOpen?.(item.path, index);
      const path = await realpath(item.path);
      if (!allowedRoots.some((root) => isWithinRoot(path, root))) {
        throw new Error(
          `attachment_files[${index}].path must be inside /workspace/{${DEFAULT_ATTACHMENT_ROOTS.join(',')}}; copy the file there first, e.g. cp "${item.path}" ${resolve(workspaceRoot, 'artifacts')}/`,
        );
      }
      const [details, pathDetails] = await Promise.all([file.stat(), stat(path)]);
      if (!details.isFile()) throw new Error(`attachment_files[${index}].path is not a file`);
      if (details.nlink !== 1) {
        throw new Error(`attachment_files[${index}].path must not have hard links`);
      }
      if (details.dev !== pathDetails.dev || details.ino !== pathDetails.ino) {
        throw new Error(`attachment_files[${index}].path changed while it was being opened`);
      }
      totalBytes += details.size;
      if (totalBytes > maxBytes) {
        throw new Error(
          `attachment_files exceeds the ${Math.floor(maxBytes / (1024 * 1024))} MiB aggregate limit`,
        );
      }

      const filename = item.filename || basename(path);
      if (
        !filename ||
        filename === '.' ||
        filename === '..' ||
        filename.includes('/') ||
        filename.includes('\\')
      ) {
        throw new Error(`attachment_files[${index}].filename must be a plain filename`);
      }
      const contentType =
        item.content_type ||
        ATTACHMENT_CONTENT_TYPES[extname(filename).toLowerCase()] ||
        'application/octet-stream';
      const result = await connector.uploadAttachment(await file.readFile(), {
        filename,
        contentType,
        contentDisposition: item.content_disposition ?? 'attachment',
        ...(item.content_id ? { contentId: item.content_id } : {}),
        ...(options.connector ? { connector: options.connector } : {}),
      });
      uploaded.push({
        filename,
        content_type: contentType,
        content_disposition: item.content_disposition ?? 'attachment',
        ...(item.content_id ? { content_id: item.content_id } : {}),
        attachment_id: result.attachment_id,
      });
    } finally {
      await file.close();
    }
  }
  return uploaded;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringField(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  return typeof value === 'string' ? value : '';
}

/** Properties of a schema node, merged across `allOf` / `anyOf` / `oneOf`. */
function schemaProperties(schema: unknown, depth = 0): Record<string, Record<string, unknown>> {
  const node = asRecord(schema);
  const merged: Record<string, Record<string, unknown>> = {};
  if (depth > 4) return merged;
  for (const combinator of ['allOf', 'anyOf', 'oneOf']) {
    const branches = node[combinator];
    if (!Array.isArray(branches)) continue;
    for (const branch of branches) Object.assign(merged, schemaProperties(branch, depth + 1));
  }
  for (const [key, value] of Object.entries(asRecord(node.properties))) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      merged[key] = value as Record<string, unknown>;
    }
  }
  return merged;
}

function isArraySchema(schema: Record<string, unknown>): boolean {
  return schema.type === 'array' || schema.items !== undefined;
}

/**
 * Where attachment handles go in the call arguments.
 *
 * An explicit dotted `attachmentPath` wins. Otherwise the shallowest array
 * property named `attachments` (any casing) in the action's input schema is
 * used — `attachments` for the Email channel, `body.message.attachments` for
 * Microsoft Graph `sendMail`, `Attachments` for Postmark. Returns null when
 * the schema declares no such array.
 */
export function attachmentSlot(inputSchema: unknown, attachmentPath?: string): string[] | null {
  if (attachmentPath !== undefined) {
    const segments = attachmentPath.split('.').map((segment) => segment.trim());
    if (segments.length === 0 || segments.some((segment) => !segment)) {
      throw new Error('attachment_path must be a dotted field path such as body.message.attachments');
    }
    return segments;
  }
  let frontier: Array<{ schema: unknown; path: string[] }> = [{ schema: inputSchema, path: [] }];
  for (let depth = 0; depth < 6 && frontier.length > 0; depth++) {
    const next: typeof frontier = [];
    for (const { schema, path } of frontier) {
      for (const [key, child] of Object.entries(schemaProperties(schema))) {
        if (/^attachments?$/i.test(key) && isArraySchema(child)) return [...path, key];
        if (!isArraySchema(child)) next.push({ schema: child, path: [...path, key] });
      }
    }
    frontier = next;
  }
  return null;
}

/** Append values to the array at `slot`, creating missing parent objects. */
export function insertAttachmentHandles(
  args: Record<string, unknown>,
  slot: string[],
  handles: unknown[],
): Record<string, unknown> {
  const root = structuredClone(args);
  let parent: Record<string, unknown> = root;
  const where: string[] = ['args'];
  for (const segment of slot.slice(0, -1)) {
    where.push(segment);
    const child = parent[segment];
    if (child === undefined) {
      parent[segment] = {};
    } else if (!child || typeof child !== 'object' || Array.isArray(child)) {
      throw new Error(
        `${where.join('.')} must be a JSON object when attachments are added (pass it as an object, not a string)`,
      );
    }
    parent = parent[segment] as Record<string, unknown>;
  }
  const leaf = slot[slot.length - 1]!;
  const existing = parent[leaf];
  if (existing !== undefined && !Array.isArray(existing)) {
    throw new Error(`${[...where, leaf].join('.')} must be an array when attachments are added`);
  }
  parent[leaf] = [...(Array.isArray(existing) ? existing : []), ...handles];
  return root;
}
