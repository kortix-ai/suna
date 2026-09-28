/**
 * Large connector results go to a file; the model gets a path and a summary.
 *
 * OpenCode truncates any tool output above 50 KB / 2000 lines and shows the
 * model only the head. A list query (a Linear GraphQL page, a CRM export) is
 * often larger, so the model received cut-off JSON and improvised. Saved as a
 * file, the result is worked through with jq or bun instead of read whole.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** The MCP `call` tool saves a result larger than this (pretty-printed). */
export const SPILL_THRESHOLD_BYTES = 16 * 1024;
const PREVIEW_CHARS = 2048;
const MAX_DEPTH = 4;
const MAX_KEYS = 40;
const MAX_ITEM_KEYS = 30;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function keyList(value: Record<string, unknown>): string {
  const keys = Object.keys(value);
  return keys.length > MAX_ITEM_KEYS ? `${keys.slice(0, MAX_ITEM_KEYS).join(',')},…` : keys.join(',');
}

/**
 * A compact outline of a JSON value: object keys (up to MAX_KEYS, MAX_DEPTH
 * deep), `array(n) of {item keys}`, strings as `string`, numbers / booleans /
 * null verbatim, and every `pageInfo` verbatim so the next cursor is visible.
 */
export function jsonShape(value: unknown, depth = 0): unknown {
  if (Array.isArray(value)) {
    if (value.length === 0) return 'array(0)';
    const first = value[0];
    const item = isRecord(first)
      ? `{${keyList(first)}}`
      : Array.isArray(first)
        ? 'array'
        : first === null
          ? 'null'
          : typeof first;
    return `array(${value.length}) of ${item}`;
  }
  if (!isRecord(value)) return typeof value === 'string' ? 'string' : value;
  if (depth >= MAX_DEPTH) return `{${keyList(value)}}`;
  const entries = Object.entries(value);
  const shape: Record<string, unknown> = {};
  for (const [key, child] of entries.slice(0, MAX_KEYS)) {
    shape[key] = key === 'pageInfo' ? child : jsonShape(child, depth + 1);
  }
  if (entries.length > MAX_KEYS) shape['…'] = `${entries.length - MAX_KEYS} more keys`;
  return shape;
}

/**
 * Write `result` in full to `path` (parent dirs created) and return the call
 * envelope with `data` replaced by `saved_to`, `bytes`, and `shape` (of `data`).
 * The envelope keeps `ok`, `status`, `account`, `approval_url` and the rest.
 */
export async function saveResult(
  result: unknown,
  path: string,
): Promise<Record<string, unknown>> {
  const text = JSON.stringify(result, null, 2);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
  const { data, ...envelope } = isRecord(result) ? result : { data: result };
  return {
    ...envelope,
    saved_to: path,
    bytes: Buffer.byteLength(text),
    shape: jsonShape(isRecord(result) && !('data' in result) ? result : data),
  };
}

const safeSegment = (value: string) => value.replace(/[^\w.-]/g, '_');

/**
 * The MCP `call` tool's output filter. At or under SPILL_THRESHOLD_BYTES the
 * result is returned untouched. Above it, the result is saved under
 * `<workspace>/.kortix/state/connector-results/` and a compact summary with a
 * ~2 KB preview comes back. If the file cannot be written, the full result is
 * returned as before.
 */
export async function spillLargeResult(
  result: unknown,
  options: { connector: string; action: string; workspaceRoot?: string },
): Promise<unknown> {
  if (Buffer.byteLength(JSON.stringify(result, null, 2)) <= SPILL_THRESHOLD_BYTES) return result;
  const root = options.workspaceRoot ?? process.env.KORTIX_INTERNAL_WORKSPACE_ROOT ?? '/workspace';
  const dir = join(root, '.kortix', 'state', 'connector-results');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const path = join(
    dir,
    `${stamp}-${safeSegment(options.connector)}-${safeSegment(options.action)}-${randomUUID().slice(0, 8)}.json`,
  );
  let summary: Record<string, unknown>;
  try {
    summary = await saveResult(result, path);
    // Ignore the directory from inside it: a spill never dirties the user's
    // git tree, whatever the repository's own .gitignore says.
    await writeFile(join(dir, '.gitignore'), '*\n');
  } catch {
    return result;
  }
  return {
    ...summary,
    preview: JSON.stringify(result).slice(0, PREVIEW_CHARS),
    hint: `The full result (${summary.bytes} bytes) is saved as JSON at ${path}; \`shape\` outlines its \`data\`. Do not read the file whole. Query it with code, e.g. jq '.data | keys' ${path}, or bun -e 'const r = await Bun.file("${path}").json(); console.log(r.data)'.`,
  };
}
