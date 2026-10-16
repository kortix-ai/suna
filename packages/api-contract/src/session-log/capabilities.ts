/**
 * The adapters' capability manifests (C12, F9) and the switch preflight (P7.1).
 *
 * `PI_CAPABILITIES` and `OPENCODE_CAPABILITIES` are what each kortixd adapter renders, natively and by
 * lowering (`port.capabilities`). They live here so apps/api reads the same manifests the boxes
 * use. `harness_versions` and `schema_minors` name what the oracle suites passed against, written by
 * hand: kortixd's `session-log-adapter-versions.test.ts` fails when a pin or `SESSION_LOG_MINOR`
 * leaves them (`apps/kortix-sandbox-agent-server/src/harness/README.md`, "Bumping a harness").
 *
 * `HARNESS_RUNTIME_CAPABILITIES` is what each harness lists in `GET /kortix/health` `capabilities`
 * (OpenCode lists `session.steer` only on 1.18.15 or later; the pinned version is later).
 *
 * `switchPreflight(log, to, ctx)` is the report of a switch to `to`:
 * - `available` / `reason`: the switch can happen. `same_harness`: the log already runs on `to`.
 *   `llm_gateway_off`: pi has no model path without the project's `llm_gateway` flag.
 * - `restores`: the project's `session_log_restore` flag (and the operator switch) is on and the log is
 *   under the API's restore cap (`SESSION_LOG_RESTORE_MAX_BYTES`), so the new box restores the log.
 *   Otherwise the new box starts without the conversation, and `losses` starts with a `history` line
 *   (every live message).
 * - `unsupported`: everything the source harness handles that `to` handles worse, used or not:
 *   model features of the manifests and runtime controls (`HARNESS_RUNTIME_CAPABILITIES`).
 * - `losses`: the `unsupported` lines the log shows in use, with counts. A feature the source
 *   harness also lacked is in neither list. A log whose harness has no manifest (a converted log,
 *   `kortix-v1-import`) counts every feature as native at the source.
 * - Model features (`CapabilityFeatures`): `degraded` when the target only renders the feature
 *   (lowered or emulated), `lost` when it cannot write it. Runtime controls are `lost`.
 * - Use counted for controls: MCP tool calls, a rewind (reverted or deleted messages), a slash
 *   command, a steer, a manual compaction. A control the log cannot show (shell, fork, attach,
 *   config) or an MCP server never called is only in `unsupported`.
 * - Reasoning (`reasoning_replay`, the `modelView` rule): an in-context assistant reasoning block of
 *   the model the session selects next (`detail: same_model`; no selection counts as that model) is
 *   replayed unless the harness says `none`; another model's (`other_model`) only as text by
 *   `lowers_to_text`. A line when the target no longer shows what the source showed.
 */
import { RUNTIME_CAPABILITIES, type RuntimeCapability } from '../runtime-relay';
import type { AdapterCapabilities, CapabilityFeatures, SessionLog, SessionLogBlock } from './types';
import type { SessionLogHarness, SessionLogSwitchPreflight, SwitchGap, SwitchLoss } from './wire';

const PI_NATIVE: CapabilityFeatures = {
  tool_error_channel: false, // openai-chat role:tool has no is_error
  attachments: { user: ['image/png', 'image/jpeg', 'image/gif', 'image/webp'], tool_result: false },
  compaction: ['summary_first_tail'],
  subagents: 'sync', // the Kortix `task` tool runs a child agent in process
  todos: false,
  reasoning_replay: 'same_model', // reasoning.ts drops another model's thinking; pi-ai would replay it as text
  freeform_tool_input: false,
};
export const PI_CAPABILITIES: AdapterCapabilities = {
  harness: 'pi',
  harness_versions: '1.0.3 || 1.2.0',
  schema_minors: [1],
  dialects: ['openai-chat'],
  native: PI_NATIVE,
  // A tool-result image becomes a follow-up user turn; a layout compaction is rendered as entries.
  rendered: { ...PI_NATIVE, attachments: { ...PI_NATIVE.attachments, tool_result: true }, compaction: ['summary_first_tail', 'layout'] },
};

const OPENCODE_NATIVE: CapabilityFeatures = {
  tool_error_channel: false, // openai-chat role:tool has no error flag
  attachments: { user: ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf'], tool_result: false },
  compaction: ['summary_first_tail'],
  subagents: 'sync', // `task` runs a child session
  todos: true,
  reasoning_replay: 'lowers_to_text', // another model's reasoning is replayed as text
  freeform_tool_input: false,
};
export const OPENCODE_CAPABILITIES: AdapterCapabilities = {
  harness: 'opencode',
  harness_versions: '1.18.23',
  schema_minors: [1],
  dialects: ['openai-chat'],
  native: OPENCODE_NATIVE,
  // A tool-result attachment becomes a follow-up user turn; a layout is emulated.
  rendered: { ...OPENCODE_NATIVE, attachments: { ...OPENCODE_NATIVE.attachments, tool_result: true }, compaction: ['summary_first_tail', 'layout'] },
};

/** The harnesses a session can run on, by id (`SessionLogHarnessSchema`). */
export const ADAPTER_CAPABILITIES: Record<SessionLogHarness, AdapterCapabilities> = { pi: PI_CAPABILITIES, opencode: OPENCODE_CAPABILITIES };

/**
 * pi: subagents (the `task` tool), compaction, slash commands (prompt templates) and steering are
 * native; rewind, fork, MCP, todo, shell and the terminal client are not (pi answers them 501).
 */
export const HARNESS_RUNTIME_CAPABILITIES: Record<SessionLogHarness, readonly RuntimeCapability[]> = {
  pi: ['session.subagents', 'session.compact', 'session.commands', 'session.steer', 'session.log.v2'],
  opencode: RUNTIME_CAPABILITIES,
};

type Level = 0 | 1 | 2; // none, rendered, native
const SUBAGENT_ORDER = ['none', 'sync', 'async'] as const;
const COMPACTION_KINDS = ['summary_first_tail', 'layout', 'text_tail', 'opaque'] as const;
type Has = (features: CapabilityFeatures) => boolean;
/** `table[key]` for an own key only: a journaled `harness.current` such as `constructor` is no harness. */
const own = <T>(table: Record<string, T>, key: string): T | undefined => (Object.hasOwn(table, key) ? table[key] : undefined);

/** What the API knows besides the log (`POST …/log/switch-preflight`). */
export type SwitchContext = {
  /** The project's `llm_gateway` flag: pi has no model path without it. */
  llmGateway: boolean;
  /** The project's `session_log_restore` flag and the operator switch are on and the log is under the restore cap: the new box restores the log. */
  restore: boolean;
  /** Tombstoned messages: OpenCode deletes the messages a rewind reverts. */
  deletedMessages?: number;
};

/** The switch report of the session `log` on the harness `to`. */
export function switchPreflight(log: SessionLog, to: SessionLogHarness, ctx: SwitchContext): SessionLogSwitchPreflight {
  const from = log.harness?.current ?? 'unknown';
  const source = own(ADAPTER_CAPABILITIES, from);
  const target = ADAPTER_CAPABILITIES[to];
  const level = (caps: AdapterCapabilities | undefined, has: Has): Level => (!caps || has(caps.native) ? 2 : has(caps.rendered) ? 1 : 0);
  const losses: SwitchLoss[] = [];
  const unsupported: SwitchGap[] = [];
  /** `useDetail` names what the log used (MCP tool names); it is no gap of its own. */
  const gap = (feature: string, used: number, status: SwitchLoss['status'], detail?: string, useDetail = detail) => {
    unsupported.push({ feature, ...(detail && { detail }), status });
    if (used > 0) losses.push({ feature, ...(useDetail && { detail: useDetail }), used, status });
  };
  const feature = (name: string, used: number, has: Has, detail?: string) => {
    const at = level(target, has);
    if (at < level(source, has)) gap(name, used, at === 1 ? 'degraded' : 'lost', detail);
  };
  const served = (h: string) => own(HARNESS_RUNTIME_CAPABILITIES, h) ?? RUNTIME_CAPABILITIES;

  const messages = log.threads.flatMap((t) => t.messages);
  const blocks = messages.flatMap((m) => m.blocks.map((b) => ({ m, b })));
  const calls = blocks.flatMap(({ b }) => (b.type === 'tool_call' ? [b] : []));
  const count = <T>(items: T[], key: (item: T) => string) => {
    const counts = new Map<string, number>();
    for (const item of items) counts.set(key(item), (counts.get(key(item)) ?? 0) + 1);
    return counts;
  };

  feature('tool_error_channel', calls.filter((c) => c.result?.is_error).length, (f) => f.tool_error_channel);
  feature('freeform_tool_input', calls.filter((c) => c.input_format === 'text').length, (f) => f.freeform_tool_input);
  const userMimes = count(blocks.flatMap(({ m, b }) => (m.role === 'user' && b.type === 'attachment' ? [b.mime] : [])), (mime) => mime);
  const knownMimes = Object.values(ADAPTER_CAPABILITIES).flatMap((c) => [...c.native.attachments.user, ...c.rendered.attachments.user]);
  for (const mime of [...new Set([...knownMimes, ...userMimes.keys()])].sort()) {
    feature('attachments.user', userMimes.get(mime) ?? 0, (f) => f.attachments.user.includes(mime), mime);
  }
  const resultAttachments = calls.flatMap((c) => [...(c.result?.content ?? []), ...(c.result?.model_content ?? [])]).filter((c) => c.type === 'attachment');
  feature('attachments.tool_result', resultAttachments.length, (f) => f.attachments.tool_result);
  const compactions = count(blocks.flatMap(({ b }) => (b.type === 'compaction' ? [b] : [])), compactionKind);
  for (const kind of COMPACTION_KINDS) feature('compaction', compactions.get(kind) ?? 0, (f) => f.compaction.includes(kind), kind);
  const children = log.threads.filter((t) => t.parent_thread_id !== null);
  const async = children.some((t) => t.interactions?.length);
  for (const mode of ['sync', 'async'] as const) {
    const used = (mode === 'async') === async ? children.length : 0;
    feature('subagents', used, (f) => SUBAGENT_ORDER.indexOf(f.subagents) >= SUBAGENT_ORDER.indexOf(mode), mode);
  }
  const next = log.selection?.model;
  const reasoning = blocks.filter(({ m, b }) => b.type === 'reasoning' && m.role === 'assistant' && m.in_context && b.text.trim());
  const same = reasoning.filter(({ m }) => !next || (m.model?.provider === next.provider && m.model?.model === next.model)).length;
  feature('reasoning_replay', same, (f) => f.reasoning_replay !== 'none', 'same_model');
  feature('reasoning_replay', reasoning.length - same, (f) => f.reasoning_replay === 'lowers_to_text', 'other_model');
  feature('todos', calls.filter((c) => c.kind === 'todo').length || (log.todos?.length ?? 0), (f) => f.todos);

  // ponytail: `mcp` is the log's tool kind, a name rule (`fromV1`: an unknown name with `_`), so a hosted
  // tool both harnesses serve can be counted; `detail` names the tools. Exact when exports mark MCP calls.
  const mcp = calls.filter((c) => c.kind === 'mcp');
  const used: Partial<Record<RuntimeCapability, [number, string?]>> = {
    'session.mcp': [mcp.length, [...new Set(mcp.map((c) => c.name))].sort().join(', ')],
    // A rewind hides messages (pi) or deletes them (OpenCode); a retract deletes one too.
    'session.rewind': [messages.filter((m) => m.hidden_reason === 'reverted').length + (ctx.deletedMessages ?? 0)],
    'session.commands': [messages.filter((m) => m.origin === 'command').length],
    'session.steer': [messages.filter((m) => m.origin === 'steer').length],
    'session.compact': [blocks.filter(({ b }) => b.type === 'compaction' && b.trigger === 'manual').length],
  };
  for (const name of RUNTIME_CAPABILITIES) {
    if (!served(from).includes(name) || served(to).includes(name)) continue;
    const [n = 0, detail] = used[name] ?? [];
    gap(name, n, 'lost', undefined, detail || undefined);
  }

  // No restore: the new box starts without the conversation, the largest loss of all.
  if (!ctx.restore && messages.length > 0) losses.unshift({ feature: 'history', used: messages.length, status: 'lost' });
  const reason = from === to ? 'same_harness' : to === 'pi' && !ctx.llmGateway ? 'llm_gateway_off' : null;
  return { session_id: log.session_id, from, to, available: reason === null, reason, restores: ctx.restore, losses, unsupported };
}

function compactionKind(b: Extract<SessionLogBlock, { type: 'compaction' }>): CapabilityFeatures['compaction'][number] {
  return b.opaque ? 'opaque' : b.layout ? 'layout' : 'summary_first_tail';
}
