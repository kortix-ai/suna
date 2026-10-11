/**
 * Large connector results go to a file; the model gets a path and a summary.
 *
 * OpenCode truncates any tool output above 50 KB / 2000 lines and shows the
 * model only the head. A list query (a Linear GraphQL page, a CRM export) is
 * often larger, so the model received cut-off JSON and improvised. Saved as a
 * file, the result is worked through with jq or bun instead of read whole.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

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
