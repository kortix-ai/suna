/**
 * The key order of tool_call inputs, kept beside the jsonb `record`
 * (`session_log_messages.tool_input_order`, a `json` column). jsonb stores object
 * keys sorted by length, then bytes; a harness serializes a call input in the order
 * the model wrote it. A restore that sends the sorted order changes the bytes of the
 * next model request from the first tool call on, so the provider prompt cache misses.
 *
 * The order is a shape: the input with every leaf as 0 (keys only, no values: a
 * write tool's file text is not stored twice). One entry per block, `null` for a
 * block that is not a tool_call with an object input.
 */
type J = Record<string, unknown>;
const isObject = (v: unknown): v is J => v !== null && typeof v === 'object' && !Array.isArray(v);

const shape = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(shape) : isObject(v) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shape(x)])) : 0;

/** `value` with the keys of every object in the order of `order`; a key `order` lacks keeps its place after them. */
function ordered(value: unknown, order: unknown): unknown {
  if (Array.isArray(value)) return Array.isArray(order) ? value.map((x, i) => ordered(x, order[i])) : value;
  if (!isObject(value) || !isObject(order)) return value;
  const keys = new Set([...Object.keys(order).filter((k) => Object.hasOwn(value, k)), ...Object.keys(value)]);
  return Object.fromEntries([...keys].map((k) => [k, ordered(value[k], order[k])]));
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
