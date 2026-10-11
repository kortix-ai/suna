/**
 * zod validators for `kortix.session/2` minor 1. Each schema mirrors a type in
 * `types.ts`; the comments there are the rules. Objects are not strict: a later
 * minor adds optional fields and an older reader must still accept the record. Enums and the
 * block union are closed, and tool `kind` passes any non-empty string (see the compatibility
 * rule in `types.ts`). `__tests__/session-log-shape.snapshot.txt` pins the shape of every
 * schema exported here.
 */
import { z } from 'zod';
import { SESSION_LOG_SCHEMA } from './types';

const str = z.string();
const nullableStr = str.nullable();
const count = z.number().int().nonnegative();
const nonEmpty = str.min(1); // pass-through strings and lookup keys: any non-empty value
const id = str.min(1); // F1: block id, unique within its message (checked on the message)

export const ExtSchema = z.record(z.object({ version: str, native_id: str.optional(), data: z.unknown() }));
export const ProducerSchema = z.object({ harness: nonEmpty, harness_version: str, adapter_version: str });
export const ModelRefSchema = z.object({
  provider: str,
  model: str,
  api: nonEmpty.optional(), // 'anthropic-messages' | 'openai-chat' | 'openai-responses' | any other dialect
  variant: str.optional(),
  reasoning_effort: str.optional(),
});
export const TodoSchema = z.object({
  id: str.optional(),
  content: str,
  status: z.enum(['pending', 'in_progress', 'completed', 'cancelled']),
  priority: z.enum(['high', 'medium', 'low']).optional(),
});
export const PendingSchema = z.object({ id: str, thread_id: str, call_id: str.optional(), payload: z.unknown(), asked_at: str });
export const UsageSchema = z.object({
  input: z.number(),
  output: z.number(),
  cache_read: z.number(),
  cache_write: z.number(),
  reasoning: z.number().optional(),
  cost: z.number().optional(),
});
export const ThreadInteractionSchema = z.object({
  message_id: str,
  call_id: str,
  op: z.enum(['spawn', 'send', 'wait', 'close', 'resume', 'result']),
});

// ─── Blocks ──────────────────────────────────────────────────────────────────

const ext = ExtSchema.optional();

export const TextBlockSchema = z.object({
  type: z.literal('text'),
  id,
  text: str,
  model_text: str.optional(),
  synthetic: z.boolean().optional(),
  ref: str.optional(), // F3
  bytes: count.optional(), // F3
  ext,
});
export const ReasoningBlockSchema = z.object({
  type: z.literal('reasoning'),
  id,
  text: str,
  summary: z.array(str).optional(),
  redacted: z.boolean().optional(),

  ext,
});
export const AttachmentBlockSchema = z.object({
  type: z.literal('attachment'),
  id,
  ref: str,
  mime: str,
  name: str.optional(),
  label: str.optional(),
  source_path: str.optional(),
  bytes: count,
  sha256: str.optional(), // F5
  ext,
});

/** F12: the known kinds are in `KnownToolKind`; a harness may define its own, so any non-empty string passes. */
export const ToolKindSchema = str.min(1);
export const ToolResultContentSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: str }),
  z.object({ type: z.literal('attachment'), ref: str, mime: str, sha256: str.optional() }),
]);
export const ToolCallBlockSchema = z.object({
  type: z.literal('tool_call'),
  id,
  call_id: str,
  name: str,
  kind: ToolKindSchema,
  input: z.unknown(),
  input_format: z.enum(['json', 'text']).optional(),
  status: z.enum(['pending', 'running', 'complete', 'error']),
  result: z
    .object({
      content: z.array(ToolResultContentSchema),
      model_content: z.array(ToolResultContentSchema).optional(),
      is_error: z.boolean(),
      error: z.object({ code: nonEmpty.optional(), message: str }).optional(),
      exit_code: z.number().optional(),
      synthetic: z.boolean().optional(),
      cleared_at: str.optional(),
      details: z.unknown(),
    })
    .optional(),
  title: str.optional(),
  started_at: str.optional(),
  ended_at: str.optional(),
  ext,
});

export const CompactionLayoutEntrySchema = z.union([
  z.object({ summary: z.literal(true) }),
  z.object({ message_id: str, text_only: z.boolean().optional() }),
  z.object({ text: str }),
]);
export const CompactionBlockSchema = z.object({
  type: z.literal('compaction'),
  id,
  summary: nullableStr,
  opaque: z.boolean().optional(),
  first_kept_message_id: nullableStr,
  layout: z.array(CompactionLayoutEntrySchema).optional(),
  tokens_before: z.number().optional(),
  trigger: z.enum(['auto', 'manual', 'overflow', 'unknown']).optional(),
  ext,
});
export const SubtaskBlockSchema = z.object({
  type: z.literal('subtask'),
  id,
  thread_id: str,
  agent: str,
  description: str,
  call_id: str.optional(),
  call_ids: z.array(str).optional(),
});
export const StepBlockSchema = z.object({ type: z.literal('step'), id, phase: z.enum(['start', 'finish']), ext });
export const HarnessBlockSchema = z.object({
  type: z.literal('harness'),
  id,
  harness: nonEmpty,
  kind: nonEmpty,
  data: z.unknown(),
  model_visible: z.boolean(),
  fallback_text: str.optional(),
});

/** An unknown `type` fails here: a block this reader does not know is not silently dropped. */
export const SessionLogBlockSchema = z.discriminatedUnion('type', [
  TextBlockSchema,
  ReasoningBlockSchema,
  AttachmentBlockSchema,
  ToolCallBlockSchema,
  CompactionBlockSchema,
  SubtaskBlockSchema,
  StepBlockSchema,
  HarnessBlockSchema,
]);

// ─── Records ─────────────────────────────────────────────────────────────────

const schemaRef = { schema: z.literal(SESSION_LOG_SCHEMA), v: z.number().int().nonnegative() };

export const SessionLogMessageSchema = z
  .object({
    ...schemaRef,
    message_id: str,
    thread_id: str,
    seq: z.number().int(),
    role: z.enum(['user', 'assistant', 'system']),
    kind: z.enum(['turn', 'compaction', 'context']),
    status: z.enum(['streaming', 'complete', 'error', 'aborted', 'interrupted']),
    in_context: z.boolean(),
    hidden_reason: z.enum(['failed_attempt', 'aborted', 'retracted', 'reverted', 'superseded']).optional(),
    origin: z.enum(['prompt', 'steer', 'command', 'automation', 'subagent', 'notification']).optional(),
    agent: nullableStr.optional(),
    native_agent_id: str.optional(), // F8
    reply_to: nullableStr.optional(),
    parent_message_id: nullableStr.optional(),
    model: ModelRefSchema.nullable(),
    usage: UsageSchema.nullable(),
    finish: z.enum(['stop', 'tool_calls', 'length', 'error', 'aborted']).nullable(),
    error: z.object({ code: nonEmpty, message: str }).nullable(),
    created_at: str,
    completed_at: nullableStr,
    producer: ProducerSchema,
    blocks: z.array(SessionLogBlockSchema),
    context_ref: str.optional(),
    ext,
  })
  .superRefine((message, ctx) => {
    // F1: a block id is unique within its message.
    const seen = new Set<string>();
    message.blocks.forEach((block, i) => {
      if (seen.has(block.id)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['blocks', i, 'id'], message: `block id ${block.id} repeats in message ${message.message_id}` });
      seen.add(block.id);
      // F3: a text stored by reference states the full text's size.
      if (block.type === 'text' && block.ref !== undefined && block.bytes === undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['blocks', i, 'bytes'], message: `text block ${block.id} has ref and no bytes` });
      }
    });
    // Closure rule (ToolCallBlock, C2): a thread at rest holds no in-context tool call that is open.
    // An exporter closes an interrupted call with `{ is_error: true, synthetic: true }`.
    // An out-of-context message (a hidden aborted reply) may keep its open call.
    if (message.status === 'streaming' || !message.in_context) return;
    message.blocks.forEach((block, i) => {
      if (block.type !== 'tool_call') return;
      if (block.status === 'pending' || block.status === 'running' || !block.result) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['blocks', i],
          message: `tool call ${block.call_id} is open (status ${block.status}, ${block.result ? 'has' : 'no'} result) in an in-context message that is not streaming`,
        });
      }
    });
  });

export const SessionLogThreadSchema = z.object({
  ...schemaRef,
  thread_id: str,
  parent_thread_id: nullableStr,
  spawned_by: z.object({ message_id: str, call_id: str }).nullable(),
  interactions: z.array(ThreadInteractionSchema).optional(),
  agent: nullableStr,
  native_agent_id: str.optional(), // F8
  nickname: nullableStr.optional(),
  title: nullableStr,
  created_at: str,
  messages: z.array(SessionLogMessageSchema),
  ext,
});

export const SessionLogSchema = z.object({
  ...schemaRef,
  session_id: str,
  title: nullableStr,
  created_at: str,
  restore_grade: z.enum(['native', 'converted', 'partial']), // F4
  grade_counts: z.object({ tool_input: count, cut_point: count, attachment: count }).optional(), // F4
  harness: z.object({
    current: str,
    history: z.array(z.object({ harness: str, version: str, from_seq: z.number(), at: str })),
  }),
  selection: z.object({ agent: nullableStr, model: ModelRefSchema.nullable() }),
  todos: z.array(TodoSchema),
  pending: z.object({ questions: z.array(PendingSchema), permissions: z.array(PendingSchema) }),
  threads: z.array(SessionLogThreadSchema),
  ext,
});

// ─── Adapter capabilities (C12, F9) ──────────────────────────────────────────

export const CapabilityFeaturesSchema = z.object({
  tool_error_channel: z.boolean(),
  attachments: z.object({ user: z.array(str), tool_result: z.boolean() }),
  compaction: z.array(z.enum(['summary_first_tail', 'layout', 'text_tail', 'opaque'])),
  subagents: z.enum(['none', 'sync', 'async']),
  todos: z.boolean(),
  reasoning_replay: z.enum(['none', 'same_model', 'lowers_to_text']),
  freeform_tool_input: z.boolean(),
});
export const AdapterCapabilitiesSchema = z.object({
  harness: str,
  harness_versions: str,
  schema_minors: z.array(z.number().int()),
  dialects: z.array(str),
  native: CapabilityFeaturesSchema,
  rendered: CapabilityFeaturesSchema,
});
