/**
 * The key order of tool_call inputs, kept beside the jsonb `record`
 * (`session_log_messages.tool_input_order`, a `json` column). jsonb stores object
 * keys sorted by length, then bytes; a harness serializes a call input in the order
 * the model wrote it. A restore that sends the sorted order changes the bytes of the
 * next model request from the first tool call on, so the provider prompt cache misses.
 *
 * The order is a shape: the input with every leaf as 0 (keys only, no values: a
 * write tool's file text is not stored twice; an array without objects is one leaf). One entry per block, `null` for a
 * block that is not a tool_call with an object input.
 */
type J = Record<string, unknown>;
const isObject = (v: unknown): v is J => v !== null && typeof v === 'object' && !Array.isArray(v);

/** An array that holds no object or array is a leaf: one `0`, not one per item. */
const shape = (v: unknown): unknown =>
  Array.isArray(v) ? (v.some((x) => x !== null && typeof x === 'object') ? v.map(shape) : 0)
  : isObject(v) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shape(x)]))
  : 0;

/**
 * `value` with the keys of every object in the order of `order`. An object whose key set
 * differs from its shape keeps its own order: the shape is stale (an old API replica wrote
 * the record and left the previous shape).
 */
function ordered(value: unknown, order: unknown): unknown {
  if (Array.isArray(value)) return Array.isArray(order) ? value.map((x, i) => ordered(x, order[i])) : value;
  if (!isObject(value) || !isObject(order)) return value;
  const keys = Object.keys(order);
  if (keys.length !== Object.keys(value).length || !keys.every((k) => Object.hasOwn(value, k))) return value;
  return Object.fromEntries(keys.map((k) => [k, ordered(value[k], order[k])]));
}

type Block = { type?: unknown; input?: unknown };
const orderable = (b: Block) => b.type === 'tool_call' && isObject(b.input);

/** The `tool_input_order` of a message record, or null when it has no tool_call object input. */
export function toolInputOrderOf(record: { blocks?: unknown }): unknown[] | null {
  const blocks = Array.isArray(record.blocks) ? (record.blocks as Block[]) : [];
  return blocks.some(orderable) ? blocks.map((b) => (orderable(b) ? shape(b.input) : null)) : null;
}

/** The record with each tool_call input in its stored key order. Mutates and returns `record`. */
export function withToolInputOrder<T extends { blocks?: unknown }>(record: T, order: unknown[] | null): T {
  if (!order || !Array.isArray(record.blocks)) return record;
  (record.blocks as Block[]).forEach((b, i) => {
    if (orderable(b) && order[i]) b.input = ordered(b.input, order[i]);
  });
  return record;
}
