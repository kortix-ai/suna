/**
 * zod validators for `kortix.session/2` minor 1. Each schema mirrors a type in
 * `types.ts`; the comments there are the rules. Objects are not strict: a later
 * minor adds optional fields and an older reader must still accept the record. Enums and the
 * block union are closed (see the compatibility rule in `types.ts`).
 */
import { z } from 'zod';
import { SESSION_LOG_SCHEMA } from './types';

const str = z.string();
const nullableStr = str.nullable();

export const ExtSchema = z.record(z.object({ version: str, native_id: str.optional(), data: z.unknown() }));
export const ProducerSchema = z.object({ harness: str, harness_version: str, adapter_version: str });
export const ModelRefSchema = z.object({
  provider: str,
  model: str,
  api: str.optional(), // 'anthropic-messages' | 'openai-chat' | 'openai-responses' | any other dialect
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

export const TextBlockSchema = z.object({ type: z.literal('text'), text: str, model_text: str.optional(), synthetic: z.boolean().optional(), ext });
export const ReasoningBlockSchema = z.object({
  type: z.literal('reasoning'),
  text: str,
  summary: z.array(str).optional(),
  redacted: z.boolean().optional(),

  ext,
});
export const AttachmentBlockSchema = z.object({
  type: z.literal('attachment'),
  ref: str,
  mime: str,
  name: str.optional(),
  label: str.optional(),
  source_path: str.optional(),
  bytes: z.number(),
  sha256: str,
  ext,
});

export const ToolKindSchema = z.enum([
  'shell', 'read', 'write', 'edit', 'patch', 'list', 'glob', 'grep',
  'web_fetch', 'web_search', 'todo', 'task', 'question', 'plan', 'mcp', 'other',
]);
export const ToolResultContentSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: str }),
  z.object({ type: z.literal('attachment'), ref: str, mime: str, sha256: str.optional() }),
]);
export const ToolCallBlockSchema = z.object({
  type: z.literal('tool_call'),
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
      error: z.object({ code: str.optional(), message: str }).optional(),
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
  thread_id: str,
  agent: str,
  description: str,
  call_id: str.optional(),
  call_ids: z.array(str).optional(),
});
export const StepBlockSchema = z.object({ type: z.literal('step'), phase: z.enum(['start', 'finish']), ext });
export const HarnessBlockSchema = z.object({
  type: z.literal('harness'),
  harness: str,
  kind: str,
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
    reply_to: nullableStr.optional(),
    parent_message_id: nullableStr.optional(),
    model: ModelRefSchema.nullable(),
    usage: UsageSchema.nullable(),
    finish: z.enum(['stop', 'tool_calls', 'length', 'error', 'aborted']).nullable(),
    error: z.object({ code: str, message: str }).nullable(),
    created_at: str,
    completed_at: nullableStr,
    producer: ProducerSchema,
    blocks: z.array(SessionLogBlockSchema),
    context_ref: str.optional(),
    ext,
  })
  .superRefine((message, ctx) => {
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
