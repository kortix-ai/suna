/**
 * Attachment references for connector calls.
 *
 * File bytes never travel through the model or the call arguments. A client
 * stages the raw bytes with `POST /connectors/attachments` and receives an
 * `attachment_id`. The call arguments then carry a reference VALUE:
 *
 *     { "$kortix_attachment": "<attachment_id>" }
 *
 * The key is namespaced so it cannot collide with an upstream API's own
 * fields (many APIs have an `attachment_id` of their own). At execution time
 * the gateway claims the staged files and replaces each reference:
 *
 * - In a string position (`contentBytes`, `content`, GitHub's file `content`,
 *   …), the reference becomes the file's base64 string.
 * - As an element of an array whose item schema is an object, the reference
 *   becomes a complete attachment item in the provider's native shape. The
 *   shape comes from an exact-key profile (Microsoft Graph, Postmark, Mailjet,
 *   SendGrid, Resend, Brevo). No field names are guessed: an item schema that
 *   matches no profile is refused, and the refusal tells the caller to put the
 *   reference in the item's base64 field itself.
 *
 * The replacement runs on the provider-bound copy only. The arguments that
 * feed the audit row, the request digest, and the approval preview keep the
 * references, so the bytes never reach them.
 */

export const ATTACHMENT_REF_KEY = '$kortix_attachment';

export interface InlineAttachmentFile {
  filename: string;
  contentType: string;
  contentDisposition: 'attachment' | 'inline';
  contentId?: string;
  bytes: Uint8Array;
}

export interface AttachmentRef {
  /** Location of the reference inside the call arguments. */
  path: Array<string | number>;
  attachmentId: string;
}

const MAX_WALK_DEPTH = 16;

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

/** `{ "$kortix_attachment": "<id>" }` and nothing else. */
export function isAttachmentRef(value: unknown): value is Record<typeof ATTACHMENT_REF_KEY, string> {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  return keys.length === 1 && keys[0] === ATTACHMENT_REF_KEY;
}

export function formatArgPath(path: Array<string | number>): string {
  return path
    .map((segment) => (typeof segment === 'number' ? `[${segment}]` : `.${segment}`))
    .join('')
    .replace(/^\./, '');
}

/** Every attachment reference in the call arguments, in document order. */
export function findAttachmentRefs(args: unknown): AttachmentRef[] {
  const found: AttachmentRef[] = [];
  const walk = (value: unknown, path: Array<string | number>, depth: number) => {
    if (depth > MAX_WALK_DEPTH) return;
    if (isAttachmentRef(value)) {
      const id = value[ATTACHMENT_REF_KEY];
      if (typeof id !== 'string' || !id.trim()) {
        throw new Error(
          `attachment_ref_invalid: ${formatArgPath(path) || 'args'} must be {"${ATTACHMENT_REF_KEY}": "<attachment_id>"}`,
        );
      }
      found.push({ path, attachmentId: id.trim() });
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, [...path, index], depth + 1));
    } else if (isRecord(value)) {
      for (const [key, child] of Object.entries(value)) walk(child, [...path, key], depth + 1);
    }
  };
  walk(args, [], 0);
  return found;
}

/* ─── schema navigation ─────────────────────────────────────────────────── */

/** Properties of a schema node, merged across `allOf` / `anyOf` / `oneOf`. */
function schemaProperties(schema: unknown, depth = 0): Record<string, Json> {
  if (!isRecord(schema) || depth > 4) return {};
  const merged: Record<string, Json> = {};
  for (const combinator of ['allOf', 'anyOf', 'oneOf'] as const) {
    const branches = schema[combinator];
    if (!Array.isArray(branches)) continue;
    for (const branch of branches) Object.assign(merged, schemaProperties(branch, depth + 1));
  }
  if (isRecord(schema.properties)) {
    for (const [key, value] of Object.entries(schema.properties)) {
      if (isRecord(value)) merged[key] = value;
    }
  }
  return merged;
}

function schemaItems(schema: unknown, depth = 0): unknown {
  if (!isRecord(schema) || depth > 4) return undefined;
  if (schema.items !== undefined) return schema.items;
  for (const combinator of ['allOf', 'anyOf', 'oneOf'] as const) {
    const branches = schema[combinator];
    if (!Array.isArray(branches)) continue;
    for (const branch of branches) {
      const items = schemaItems(branch, depth + 1);
      if (items !== undefined) return items;
    }
  }
  return undefined;
}

/** The schema node that describes the value at `path`, or undefined. */
function schemaAt(root: unknown, path: Array<string | number>): unknown {
  let node: unknown = root;
  for (const segment of path) {
    node = typeof segment === 'number' ? schemaItems(node) : schemaProperties(node)[segment];
    if (node === undefined) return undefined;
  }
  return node;
}

function isObjectSchema(schema: unknown): boolean {
  if (!isRecord(schema)) return false;
  return schema.type === 'object' || Object.keys(schemaProperties(schema)).length > 0;
}

/* ─── provider item profiles ────────────────────────────────────────────── */

interface ItemProfile {
  name: string;
  /** All of these keys must be declared by the item schema (exact spelling). */
  match: string[][];
  build(file: InlineAttachmentFile, base64: string, declared: Set<string>): Json;
}

/** Add `key: value` only when the item schema declares `key`. */
function declaredOnly(declared: Set<string>, fields: Json): Json {
  return Object.fromEntries(
    Object.entries(fields).filter(([key, value]) => declared.has(key) && value !== undefined),
  );
}

const inline = (file: InlineAttachmentFile) => file.contentDisposition === 'inline';

const ITEM_PROFILES: ItemProfile[] = [
  {
    // Microsoft Graph `fileAttachment`. Graph's own OpenAPI types the array
    // with the `attachment` base type, which declares no contentBytes, so the
    // OData type annotation also identifies it. The shape is fixed by Graph.
    name: 'microsoft-graph',
    match: [['name', 'contentBytes'], ['name', '@odata.type']],
    build: (file, base64) => ({
      '@odata.type': '#microsoft.graph.fileAttachment',
      name: file.filename,
      contentType: file.contentType,
      contentBytes: base64,
      ...(inline(file) ? { isInline: true } : {}),
      ...(inline(file) && file.contentId ? { contentId: file.contentId } : {}),
    }),
  },
  {
    name: 'postmark',
    match: [['Name', 'Content']],
    build: (file, base64, declared) => ({
      Name: file.filename,
      Content: base64,
      ...declaredOnly(declared, {
        ContentType: file.contentType,
        ContentID: inline(file) && file.contentId ? `cid:${file.contentId}` : undefined,
      }),
    }),
  },
  {
    name: 'mailjet',
    match: [['Filename', 'Base64Content']],
    build: (file, base64, declared) => ({
      Filename: file.filename,
      Base64Content: base64,
      ...declaredOnly(declared, {
        ContentType: file.contentType,
        ContentID: inline(file) ? file.contentId : undefined,
      }),
    }),
  },
  {
    // SendGrid (`type` + `disposition`) and Resend (`content_type`) share the
    // `filename` + `content` core; optional fields follow the declared keys.
    name: 'filename-content',
    match: [['filename', 'content']],
    build: (file, base64, declared) => ({
      filename: file.filename,
      content: base64,
      ...declaredOnly(declared, {
        type: file.contentType,
        content_type: file.contentType,
        contentType: file.contentType,
        disposition: file.contentDisposition,
        content_id: inline(file) ? file.contentId : undefined,
        contentId: inline(file) ? file.contentId : undefined,
      }),
    }),
  },
  {
    name: 'name-content',
    match: [['name', 'content']],
    build: (file, base64, declared) => ({
      name: file.filename,
      content: base64,
      ...declaredOnly(declared, { contentType: file.contentType, content_type: file.contentType }),
    }),
  },
];

/** The profile an item schema selects, or null. Exported for tests. */
export function itemProfileFor(itemSchema: unknown): ItemProfile | null {
  const declared = new Set(Object.keys(schemaProperties(itemSchema)));
  return (
    ITEM_PROFILES.find((profile) =>
      profile.match.some((keys) => keys.every((key) => declared.has(key))),
    ) ?? null
  );
}

function buildItem(itemSchema: unknown, file: InlineAttachmentFile, where: string): Json {
  const profile = itemProfileFor(itemSchema);
  if (!profile) {
    const declared = Object.keys(schemaProperties(itemSchema));
    throw new Error(
      `attachment_item_shape_unknown: ${where} items declare {${declared.join(', ')}}, which match no known attachment shape. ` +
        `Write the item yourself and put {"${ATTACHMENT_REF_KEY}": "<attachment_id>"} in its base64 field.`,
    );
  }
  const base64 = Buffer.from(file.bytes).toString('base64');
  return profile.build(file, base64, new Set(Object.keys(schemaProperties(itemSchema))));
}

/**
 * Return a copy of `args` with every reference replaced (see the file header).
 * `files` is keyed by attachment id and must hold every referenced id.
 */
export function resolveAttachmentRefs(
  args: Json,
  inputSchema: unknown,
  refs: AttachmentRef[],
  files: Map<string, InlineAttachmentFile>,
): Json {
  const next = structuredClone(args);
  for (const ref of refs) {
    if (ref.path.length === 0) throw new Error('attachment_ref_invalid: args itself cannot be a reference');
    const file = files.get(ref.attachmentId);
    if (!file) throw new Error('attachment_not_found');
    const last = ref.path[ref.path.length - 1];
    const parentPath = ref.path.slice(0, -1);
    const schema = schemaAt(inputSchema, ref.path);
    const value =
      typeof last === 'number' && isObjectSchema(schema)
        ? buildItem(schema, file, formatArgPath(parentPath))
        : Buffer.from(file.bytes).toString('base64');
    let parent: unknown = next;
    for (const segment of parentPath) parent = (parent as Record<string | number, unknown>)[segment];
    (parent as Record<string | number, unknown>)[last as string | number] = value;
  }
  return next;
}

/**
 * The native Email channel sends files by signed URL, not inline bytes. It
 * takes references only as `attachments[]` elements, which become the
 * channel's own `{ attachment_id }` handles.
 */
export function emailChannelAttachmentArgs(args: Json, refs: AttachmentRef[]): Json {
  const next = structuredClone(args);
  for (const ref of refs) {
    const [field, index, ...rest] = ref.path;
    if (field !== 'attachments' || typeof index !== 'number' || rest.length > 0) {
      throw new Error(
        `attachment_ref_unsupported: the Email channel takes files only as attachments[] elements, not at ${formatArgPath(ref.path)}`,
      );
    }
    (next.attachments as unknown[])[index] = { attachment_id: ref.attachmentId };
  }
  return next;
}

/**
 * Remove long base64 runs from an upstream error before it reaches logs, the
 * audit row, or the model. Some APIs echo the rejected request body.
 */
export function redactInlineBytes(reason: string): string {
  return reason.replace(/[A-Za-z0-9+/_-]{120,}={0,2}/g, '[redacted-bytes]');
}
