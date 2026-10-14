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
 * `switchPreflight(log, to)` is the loss report of a switch to `to`: one line for each feature the
 * session used that `to` handles worse than the harness that wrote it. A feature the source
 * harness also lacked is no loss (the model never had it). A log whose harness has no manifest
 * (a converted log, `kortix-v1-import`) counts every feature as native at the source.
 * - Model features (`CapabilityFeatures`): `degraded` when the target only renders the feature
 *   (lowered or emulated), `lost` when it cannot write it.
 * - Runtime controls (`RuntimeCapability`): `lost` when the target harness does not serve the
 *   control the session used (MCP tools, a rewind, a slash command, a steer, a manual compaction).
 * - Reasoning (`reasoning_replay`, the `modelView` rule): an in-context assistant reasoning block of
 *   the model the session selects next (`detail: same_model`; no selection counts as that model) is
 *   replayed unless the harness says `none`; another model's (`other_model`) only as text by
 *   `lowers_to_text`. A line when the target no longer shows what the source showed.
 * Not reported: `session.shell` (a shell turn leaves no mark in the log), `session.fork` and
 * `session.attach`.
 */
import { RUNTIME_CAPABILITIES, type RuntimeCapability } from '../runtime-relay';
import type { AdapterCapabilities, CapabilityFeatures, SessionLog, SessionLogBlock } from './types';
import type { SessionLogHarness, SessionLogSwitchPreflight, SwitchLoss } from './wire';

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
  harness_versions: '1.0.3',
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
type Has = (features: CapabilityFeatures) => boolean;

/** The loss report of switching the session `log` describes to the harness `to`. */
export function switchPreflight(log: SessionLog, to: SessionLogHarness): SessionLogSwitchPreflight {
  const from = log.harness?.current ?? 'unknown';
  const source: AdapterCapabilities | undefined = ADAPTER_CAPABILITIES[from as SessionLogHarness];
  const target = ADAPTER_CAPABILITIES[to];
  const level = (caps: AdapterCapabilities | undefined, has: Has): Level => (!caps || has(caps.native) ? 2 : has(caps.rendered) ? 1 : 0);
  const losses: SwitchLoss[] = [];
  const feature = (name: string, used: number, has: Has, detail?: string) => {
    const at = level(target, has);
    if (used > 0 && at < level(source, has)) losses.push({ feature: name, ...(detail && { detail }), used, status: at === 1 ? 'degraded' : 'lost' });
  };
  const control = (name: RuntimeCapability, used: number, detail?: string) => {
    const served = (h: string) => (HARNESS_RUNTIME_CAPABILITIES[h as SessionLogHarness] ?? RUNTIME_CAPABILITIES).includes(name);
    if (used > 0 && served(from) && !served(to)) losses.push({ feature: name, ...(detail && { detail }), used, status: 'lost' });
  };

  const messages = log.threads.flatMap((t) => t.messages);
  const blocks = messages.flatMap((m) => m.blocks.map((b) => ({ m, b })));
  const calls = blocks.flatMap(({ b }) => (b.type === 'tool_call' ? [b] : []));
  const tally = <K extends string>(keys: K[]) => {
    const counts = new Map<K, number>();
    for (const k of keys) counts.set(k, (counts.get(k) ?? 0) + 1);
    return counts;
  };

  feature('tool_error_channel', calls.filter((c) => c.result?.is_error).length, (f) => f.tool_error_channel);
  feature('freeform_tool_input', calls.filter((c) => c.input_format === 'text').length, (f) => f.freeform_tool_input);
  const userMimes = blocks.flatMap(({ m, b }) => (m.role === 'user' && b.type === 'attachment' ? [b.mime] : []));
  for (const [mime, used] of tally(userMimes)) feature('attachments.user', used, (f) => f.attachments.user.includes(mime), mime);
  const resultAttachments = calls.flatMap((c) => [...(c.result?.content ?? []), ...(c.result?.model_content ?? [])]).filter((c) => c.type === 'attachment');
  feature('attachments.tool_result', resultAttachments.length, (f) => f.attachments.tool_result);
  const compactions = blocks.flatMap(({ b }) => (b.type === 'compaction' ? [compactionKind(b)] : []));
  for (const [kind, used] of tally(compactions)) feature('compaction', used, (f) => f.compaction.includes(kind), kind);
  const children = log.threads.filter((t) => t.parent_thread_id !== null);
  const mode = children.some((t) => t.interactions?.length) ? 'async' : 'sync';
  feature('subagents', children.length, (f) => SUBAGENT_ORDER.indexOf(f.subagents) >= SUBAGENT_ORDER.indexOf(mode), mode);
  const next = log.selection?.model;
  const reasoning = blocks.filter(({ m, b }) => b.type === 'reasoning' && m.role === 'assistant' && m.in_context && b.text.trim());
  const same = reasoning.filter(({ m }) => !next || (m.model?.provider === next.provider && m.model?.model === next.model)).length;
  feature('reasoning_replay', same, (f) => f.reasoning_replay !== 'none', 'same_model');
  feature('reasoning_replay', reasoning.length - same, (f) => f.reasoning_replay === 'lowers_to_text', 'other_model');
  feature('todos', calls.filter((c) => c.kind === 'todo').length || (log.todos?.length ?? 0), (f) => f.todos);

  // ponytail: `mcp` is the log's tool kind, a name rule (`fromV1`: an unknown name with `_`), so a hosted
  // tool both harnesses serve can be counted; `detail` names the tools. Exact when exports mark MCP calls.
  const mcp = calls.filter((c) => c.kind === 'mcp');
  control('session.mcp', mcp.length, [...new Set(mcp.map((c) => c.name))].sort().join(', '));
  control('session.rewind', messages.filter((m) => m.hidden_reason === 'reverted').length);
  control('session.commands', messages.filter((m) => m.origin === 'command').length);
  control('session.steer', messages.filter((m) => m.origin === 'steer').length);
  const manual = blocks.filter(({ b }) => b.type === 'compaction' && b.trigger === 'manual');
  control('session.compact', manual.length);

  return { session_id: log.session_id, from, to, losses };
}

function compactionKind(b: Extract<SessionLogBlock, { type: 'compaction' }>): CapabilityFeatures['compaction'][number] {
  return b.opaque ? 'opaque' : b.layout ? 'layout' : 'summary_first_tail';
}
