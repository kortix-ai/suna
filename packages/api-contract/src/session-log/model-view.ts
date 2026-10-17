/**
 * The session-log oracle: what the model sees for a stored session, and the normalizers that
 * project a request a harness really sent onto the same shape. A restore passes when
 * `canonicalizeView(modelView(...))` equals `canonicalizeView(normalizeRequest(api, body))`.
 *
 * Ported from the tested session-log prototype oracle (65 of 65 cross-harness restores). The
 * prototype is an external repository. Two changes: the view takes a `target` (decision D5, the
 * reasoning rule), and an attachment without `sha256` falls back to its `ref` (freeze addition F5).
 * It never calls a model: it compares recorded requests.
 *
 * The rules, per thread (the "What the model sees" rules in `types.ts`):
 *  - only messages with `in_context: true` and `kind: 'turn'`, in `seq` order. A `context` message
 *    is harness-injected text that the harness rebuilds from config, so the view omits it;
 *  - the last in-context compaction replaces every message before it. With `layout`: exactly the
 *    listed entries in order. Without `layout`: the summary, then the messages from
 *    `first_kept_message_id` up to the marker. A `summary: null` compaction adds no summary item;
 *  - text is `model_text ?? text`; the text blocks of one message are separate segments, and the
 *    comparison joins them. An assistant `synthetic` text block is dropped;
 *  - a tool call contributes `call_id`, `name`, `input` and `result.model_content ?? result.content`;
 *  - an attachment contributes the bytes behind `ref`. The view carries the content id (`sha256`, or
 *    the hash in a `blob:<sha256>` ref), never the bytes. A block without `ref` (F13, bytes missing) adds nothing;
 *  - a harness block with `model_visible: false` is dropped. A visible one contributes `fallback_text`;
 *  - reasoning follows `target` (see `ViewTarget`).
 */
import { createHash } from 'node:crypto';
import type { CapabilityFeatures, CompactionBlock, ModelRef, SessionLog, SessionLogBlock, SessionLogMessage } from './types';

// ─── view types ──────────────────────────────────────────────────────────────

export type ModelViewItem =
  | { role: 'user'; text: string[]; images: string[] }
  | { role: 'assistant'; text: string[]; calls: Array<{ id: string; name: string; input: unknown }>; reasoning?: string[] }
  | { role: 'tool'; call_id: string; content: string; is_error?: boolean; images?: string[] }
  | { role: 'summary'; text: string };
export type ModelView = ModelViewItem[];

/**
 * The model the next request goes to. `provider` and `model` decide reasoning:
 *  - `reasoning_replay: 'same_model'` (default): an assistant message whose `model` has the same
 *    provider and model keeps its reasoning in the item's `reasoning`; any other reasoning is dropped
 *    (a message without a `model` counts as another model);
 *  - `'lowers_to_text'` (OpenCode v1 and v2): same as above, but another model's reasoning stays
 *    in place as assistant text, in block order;
 *  - `'none'`: no reasoning is replayed.
 * Use the target harness's `CapabilityFeatures.reasoning_replay`. `api` names the wire dialect for
 * `normalizeRequest`.
 */
export type ViewTarget = {
  provider: string;
  model: string;
  api?: ModelRef['api'];
  reasoning_replay?: CapabilityFeatures['reasoning_replay'];
};

export type ModelViewOptions = {
  /** Text appended as a final user item (the next prompt). */
  next_prompt?: string;
  /** Reads the full text behind a `TextBlock.ref` (F3). Without it, such a block throws. */
  resolve_text?: (ref: string) => string;
};

const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const refSha = (ref: string) => (ref.startsWith('blob:') ? ref.slice(5) : ref);
/** The content id of an attachment: its `sha256`, else the hash in its `ref`. F13: a block with neither has no bytes (a missing v1 object), and the model sees nothing for it. */
const attachmentId = (a: { sha256?: string; ref?: string }): string[] => (a.sha256 ? [a.sha256] : a.ref ? [refSha(a.ref)] : []);

// ─── record → view ───────────────────────────────────────────────────────────

/** The view of every thread of the record, keyed by `thread_id`. */
export function modelView(log: SessionLog, target: ViewTarget, opts: ModelViewOptions = {}): Record<string, ModelView> {
  return Object.fromEntries(log.threads.map((t) => [t.thread_id, threadView(log, t.thread_id, target, opts)]));
}

/** The view of one thread. Throws when the thread does not exist. */
export function threadView(log: SessionLog, threadId: string, target: ViewTarget, opts: ModelViewOptions = {}): ModelView {
  const thread = log.threads.find((t) => t.thread_id === threadId);
  if (!thread) throw new Error(`no thread ${threadId}`);
  const msgs = [...thread.messages].sort((a, b) => a.seq - b.seq);
  const byId = new Map(msgs.map((m) => [m.message_id, m]));
  const visible = (m: SessionLogMessage) => m.in_context && m.kind === 'turn';
  const view = (m: SessionLogMessage) => messageView(m, target, opts);

  let compIdx = -1;
  msgs.forEach((m, i) => { if (m.kind === 'compaction' && m.in_context) compIdx = i; });
  const out: ModelView = [];
  let rest = msgs;
  if (compIdx >= 0) {
    // compIdx >= 0 indexes msgs; `?.` only satisfies noUncheckedIndexedAccess.
    const block = msgs[compIdx]?.blocks.find((b): b is CompactionBlock => b.type === 'compaction');
    if (block?.layout) {
      for (const entry of block.layout) {
        if ('summary' in entry) {
          if (block.summary) out.push({ role: 'summary', text: block.summary.trim() });
        } else if ('text' in entry) out.push({ role: 'user', text: [entry.text], images: [] });
        else {
          const m = byId.get(entry.message_id);
          if (!m) continue;
          const v = view(m);
          out.push(...(entry.text_only ? v.map((it) => (it.role === 'user' ? { ...it, images: [] } : it)) : v));
        }
      }
    } else if (block) {
      if (block.summary) out.push({ role: 'summary', text: block.summary.trim() });
      const k = block.first_kept_message_id ? msgs.findIndex((m) => m.message_id === block.first_kept_message_id) : -1;
      if (k >= 0) for (const m of msgs.slice(k, compIdx).filter(visible)) out.push(...view(m));
    }
    rest = msgs.slice(compIdx + 1);
  }
  for (const m of rest.filter(visible)) out.push(...view(m));
  if (opts.next_prompt) out.push({ role: 'user', text: [opts.next_prompt], images: [] });
  return out;
}

function blockText(b: Extract<SessionLogBlock, { type: 'text' }>, opts: ModelViewOptions): string {
  if (b.model_text !== undefined) return b.model_text.trim();
  if (!b.ref) return b.text.trim();
  if (!opts.resolve_text) throw new Error(`text block ${b.id} is stored by reference (${b.ref}); pass resolve_text`);
  return opts.resolve_text(b.ref).trim();
}

function segments(m: SessionLogMessage, target: ViewTarget, opts: ModelViewOptions): { text: string[]; reasoning: string[] } {
  const replay = target.reasoning_replay ?? 'same_model';
  const sameModel = m.model?.provider === target.provider && m.model?.model === target.model;
  const text: string[] = [];
  const reasoning: string[] = [];
  for (const b of m.blocks) {
    if (b.type === 'text' && !(m.role === 'assistant' && b.synthetic)) text.push(blockText(b, opts));
    else if (b.type === 'harness' && b.model_visible && b.fallback_text) text.push(b.fallback_text.trim());
    else if (b.type === 'reasoning' && m.role === 'assistant' && b.text.trim()) {
      if (replay !== 'none' && sameModel) reasoning.push(b.text.trim());
      else if (replay === 'lowers_to_text' && !sameModel) text.push(b.text.trim());
    }
  }
  return { text: text.filter(Boolean), reasoning };
}

function messageView(m: SessionLogMessage, target: ViewTarget, opts: ModelViewOptions): ModelView {
  const { text, reasoning } = segments(m, target, opts);
  if (m.role === 'user') {
    const images = m.blocks.flatMap((b) => (b.type === 'attachment' ? attachmentId(b) : []));
    return [{ role: 'user', text, images }];
  }
  if (m.role !== 'assistant') return [];
  const calls = m.blocks.flatMap((b) => (b.type === 'tool_call' ? [{ id: b.call_id, name: b.name, input: b.input }] : []));
  const out: ModelView = [{ role: 'assistant', text, calls, ...(reasoning.length ? { reasoning } : {}) }];
  for (const b of m.blocks) {
    if (b.type !== 'tool_call' || !b.result) continue;
    const rc = b.result.model_content ?? b.result.content;
    const content = rc.flatMap((c) => (c.type === 'text' ? [c.text] : [])).join('\n').trim();
    const images = rc.flatMap((c) => (c.type === 'attachment' ? attachmentId(c) : []));
    out.push({ role: 'tool', call_id: b.call_id, content, is_error: b.result.is_error, ...(images.length ? { images } : {}) });
  }
  return out;
}

// ─── request body → view ─────────────────────────────────────────────────────

/** A recorded request body: the three dialects are plain JSON, so the normalizers read it untyped. */
type Body = any;

const textOf = (c: unknown): string[] => {
  if (typeof c === 'string') return [c];
  if (Array.isArray(c)) return c.flatMap((p) => (p?.type === 'text' || p?.type === 'input_text' || p?.type === 'output_text' ? [String(p.text)] : []));
  return [];
};
const dataUrlSha = (url: unknown) => (typeof url === 'string' && url.startsWith('data:') ? [sha256(Buffer.from(url.slice(url.indexOf(',') + 1), 'base64'))] : []);
const attachmentShas = (c: unknown): string[] => {
  if (!Array.isArray(c)) return [];
  return c.flatMap((p) => {
    if (p?.type === 'image_url') return dataUrlSha(p.image_url?.url ?? p.image_url);
    if (p?.type === 'input_image') return dataUrlSha(p.image_url);
    if (p?.type === 'file') return dataUrlSha(p.file?.file_data);
    if ((p?.type === 'image' || p?.type === 'document') && p?.source?.type === 'base64') return [sha256(Buffer.from(p.source.data, 'base64'))];
    if (p?.type === 'document' && p?.source?.type === 'text') return [sha256(Buffer.from(String(p.source.data)))];
    return [];
  });
};
const parseArgs = (a: unknown) => {
  if (typeof a !== 'string') return a;
  try { return JSON.parse(a); } catch { return a; }
};
/** Harnesses that move tool-result media into a follow-up user message (pi, OpenCode). */
const TOOL_MEDIA_FOLLOWUP = /^(Attached image\(s\) from tool result:|Attached media from tool result:)\s*$/;

/**
 * OpenAI chat-completions request (pi, OpenCode). System and developer messages are dropped.
 * A user turn that only carries tool-result media folds into the previous tool item. No error
 * channel on tool results.
 */
export function normalizeOpenAIChat(body: Body): ModelView {
  const out: ModelView = [];
  for (const m of body.messages ?? []) {
    if (m.role === 'system' || m.role === 'developer') continue;
    if (m.role === 'user') {
      const text = textOf(m.content);
      const prev = out[out.length - 1];
      const imageOnly = text.every((x) => !x.trim()) && attachmentShas(m.content).length > 0;
      if (prev?.role === 'tool' && ((text.length === 1 && TOOL_MEDIA_FOLLOWUP.test((text[0] ?? '').trim())) || imageOnly)) {
        prev.images = [...(prev.images ?? []), ...attachmentShas(m.content)];
        continue;
      }
      out.push({ role: 'user', text, images: attachmentShas(m.content) });
    } else if (m.role === 'assistant') {
      out.push({ role: 'assistant', text: textOf(m.content), calls: (m.tool_calls ?? []).map((t: Body) => ({ id: t.id, name: t.function?.name, input: parseArgs(t.function?.arguments) })) });
    } else if (m.role === 'tool') {
      const images = attachmentShas(m.content);
      out.push({ role: 'tool', call_id: m.tool_call_id, content: textOf(m.content).join('\n'), ...(images.length ? { images } : {}) });
    }
  }
  return out;
}

/** Anthropic messages request (Claude Code). Carries `is_error`. Non-user, non-assistant roles are skipped. */
export function normalizeAnthropic(body: Body): ModelView {
  const out: ModelView = [];
  for (const m of body.messages ?? []) {
    const content: Body[] = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content;
    if (m.role === 'user') {
      for (const r of content.filter((p) => p.type === 'tool_result')) {
        const rc = typeof r.content === 'string' ? [{ type: 'text', text: r.content }] : r.content ?? [];
        const images = attachmentShas(rc);
        out.push({ role: 'tool', call_id: r.tool_use_id, content: textOf(rc).join('\n'), is_error: r.is_error === true, ...(images.length ? { images } : {}) });
      }
      const text = content.filter((p) => p.type === 'text').map((p) => p.text);
      const images = attachmentShas(content.filter((p) => p.type !== 'tool_result'));
      if (text.length || images.length) out.push({ role: 'user', text, images });
    } else if (m.role === 'assistant') {
      out.push({
        role: 'assistant',
        text: content.filter((p) => p.type === 'text').map((p) => p.text),
        calls: content.filter((p) => p.type === 'tool_use').map((p) => ({ id: p.id, name: p.name, input: p.input })),
      });
    }
  }
  return out;
}

/**
 * OpenAI Responses request (Codex). No error channel on tool results. Consecutive assistant
 * messages and calls merge into one assistant item. Reasoning items are provider state and are ignored.
 */
export function normalizeResponses(body: Body): ModelView {
  const out: ModelView = [];
  let current: Extract<ModelViewItem, { role: 'assistant' }> | null = null;
  const flush = () => {
    if (current) out.push(current);
    current = null;
  };
  for (const it of body.input ?? []) {
    if (it.type === 'message' || (it.role && !it.type)) {
      if (it.role === 'system' || it.role === 'developer') continue;
      if (it.role === 'user') {
        flush();
        out.push({ role: 'user', text: textOf(it.content), images: attachmentShas(it.content) });
      } else if (it.role === 'assistant') {
        current ??= { role: 'assistant', text: [], calls: [] };
        current.text.push(...textOf(it.content));
      }
    } else if (it.type === 'function_call' || it.type === 'custom_tool_call' || it.type === 'local_shell_call') {
      current ??= { role: 'assistant', text: [], calls: [] };
      current.calls.push({ id: it.call_id, name: it.name ?? it.type, input: parseArgs(it.arguments ?? it.input ?? it.action) });
    } else if (it.type === 'function_call_output' || it.type === 'custom_tool_call_output' || it.type === 'local_shell_call_output') {
      flush();
      const o = it.output;
      const parts = typeof o === 'string' ? null : Array.isArray(o) ? o : o?.content;
      const images = parts ? attachmentShas(parts) : [];
      const content = typeof o === 'string' ? o : textOf(parts).join('\n');
      out.push({ role: 'tool', call_id: it.call_id, content, ...(images.length ? { images } : {}) });
    }
  }
  flush();
  return out;
}

/** Normalizes a request body by wire dialect. Throws on a dialect without a normalizer. */
export function normalizeRequest(api: NonNullable<ModelRef['api']>, body: unknown): ModelView {
  if (api === 'openai-chat') return normalizeOpenAIChat(body);
  if (api === 'anthropic-messages') return normalizeAnthropic(body);
  if (api === 'openai-responses') return normalizeResponses(body);
  throw new Error(`no request normalizer for api ${api}`);
}

// ─── canonicalize and compare ────────────────────────────────────────────────

export type ViewCompareOptions = {
  /** Harness-injected text to drop before comparing (system reminders, environment blocks). Applied to both sides. */
  ignore?: RegExp[];
  /** The compaction summary: a text segment that contains it becomes its own `summary` item. */
  summary?: string | null;
  /** Drop user items that are empty after `ignore` (harness boilerplate turns). */
  dropEmpty?: boolean;
  /** `segment` (default): the segment holding the summary is replaced by it. `substring`: only the summary
   *  text is removed and the rest stays as text after it (a harness that sends summary and kept text in one string).
   *  Known blind spot of `segment`: any other text in the segment that holds the summary is dropped, so extra
   *  model-visible text beside a summary passes undetected (pi, OpenCode v1, Claude Code, Codex). Only `substring`
   *  (OpenCode v2) compares that remainder. A test pins this; changing it is a deliberate decision (P6.5). */
  summarySplit?: 'segment' | 'substring';
};

export type CanonItem =
  | { role: 'user'; t: string; att: string[] }
  | { role: 'assistant'; t: string; calls: Array<{ id: string; name: string; input: unknown }> }
  | { role: 'tool'; call_id: string; t: string; att?: string[]; is_error?: boolean }
  | { role: 'summary' };

const squash = (s: string) => s.replace(/\s+/g, '');
/** A JSON value with object keys sorted at every depth; arrays keep their order. Key order is not semantic (v1 `same`), and jsonb does not keep it. */
const sortKeys = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(sortKeys) : v !== null && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys((v as Record<string, unknown>)[k])])) : v;

/**
 * The comparable form of a view, applied to both sides:
 *  - call ids become ordinals (#1, #2, ...), so a harness may re-mint ids;
 *  - the text of one item is joined and compared without whitespace (harnesses join with "", "\n" or blocks);
 *  - consecutive user items merge; an assistant item with calls absorbs a following one without text;
 *  - freeform string tool input equals the `{ input }` wrapper that object-only harnesses use;
 *  - tool input compares without key order (Postgres jsonb reorders keys); arrays keep their order;
 *  - reasoning is provider state, not conversation content, and is dropped.
 */
export function canonicalizeView(view: ModelView, opts: ViewCompareOptions = {}): CanonItem[] {
  const ids = new Map<string, string>();
  const ord = (id: string) => {
    if (!ids.has(id)) ids.set(id, `#${ids.size + 1}`);
    return ids.get(id) as string;
  };
  const clean = (t: string) => {
    let s = t;
    for (const re of opts.ignore ?? []) s = s.replace(re, '');
    return s.trim();
  };
  const summary = opts.summary?.trim() || null;
  const out: CanonItem[] = [];
  const pushSummary = () => {
    if (out[out.length - 1]?.role !== 'summary') out.push({ role: 'summary' });
  };
  for (const it of view) {
    if (it.role === 'summary') { pushSummary(); continue; }
    if (it.role === 'tool') {
      out.push({ role: 'tool', call_id: ord(it.call_id), t: squash(clean(it.content)), ...(it.images?.length ? { att: [...it.images] } : {}), ...(it.is_error !== undefined ? { is_error: it.is_error } : {}) });
      continue;
    }
    let segs = it.text.map(clean).filter(Boolean);
    const images = it.role === 'user' ? [...it.images] : [];
    if (summary && segs.some((s) => s.includes(summary))) {
      // Order-preserving split: segments before the summary stay before it, the rest after it.
      const i = segs.findIndex((s) => s.includes(summary));
      const before = segs.slice(0, i);
      if (before.length && it.role === 'user') {
        const prev = out[out.length - 1];
        const tb = squash(before.join(''));
        if (prev?.role === 'user') prev.t += tb;
        else out.push({ role: 'user', t: tb, att: [] });
      }
      pushSummary();
      // `i` comes from findIndex over `segs`, so `segs[i]` exists; `?? ''` only satisfies noUncheckedIndexedAccess.
      const remainder = opts.summarySplit === 'substring' ? clean((segs[i] ?? '').replace(summary, '')) : '';
      segs = [...(remainder ? [remainder] : []), ...segs.slice(i + 1).filter((s) => !s.includes(summary))];
    }
    const t = squash(segs.join(''));
    if (it.role === 'user') {
      if (!t && !images.length && (opts.dropEmpty || segs.length !== it.text.length)) continue;
      const prev = out[out.length - 1];
      if (prev?.role === 'user') { prev.t += t; prev.att.push(...images); continue; }
      out.push({ role: 'user', t, att: images });
    } else {
      const calls = it.calls.map((c) => ({ id: ord(c.id), name: c.name, input: typeof c.input === 'string' ? { input: c.input } : sortKeys(c.input) }));
      const prev = out[out.length - 1];
      if (prev?.role === 'assistant' && (!prev.calls.length || !t)) { prev.t += t; prev.calls.push(...calls); continue; }
      if (!t && !calls.length) continue;
      out.push({ role: 'assistant', t, calls });
    }
  }
  return out;
}

const withoutError = <T extends CanonItem | null>(x: T): T => {
  if (x?.role !== 'tool') return x;
  const { is_error: _drop, ...rest } = x;
  return rest as T;
};

/**
 * Compares an expected and an actual view after `canonicalizeView`. `is_error` counts only when
 * the actual side carries it (the Anthropic dialect); `is_error: false` equals an absent one.
 */
export function compareViews(expected: ModelView, actual: ModelView, opts: ViewCompareOptions = {}) {
  const e = canonicalizeView(expected, opts);
  const a = canonicalizeView(actual, opts);
  const diffs: string[] = [];
  for (let i = 0; i < Math.max(e.length, a.length); i++) {
    let x = e[i] ?? null;
    let y = a[i] ?? null;
    if (x?.role === 'tool' && y?.role === 'tool' && y.is_error === undefined) x = withoutError(x);
    if (x?.role === 'tool' && x.is_error === false) x = withoutError(x);
    if (y?.role === 'tool' && y.is_error === false) y = withoutError(y);
    if (JSON.stringify(x) !== JSON.stringify(y)) diffs.push(`#${i}\n  expected: ${JSON.stringify(x)}\n  actual:   ${JSON.stringify(y)}`);
  }
  return { pass: diffs.length === 0, diffs, expected: e, actual: a };
}

// ─── per-harness compare options ─────────────────────────────────────────────

/** The newest compaction of a thread. `anyCompaction` also counts one out of context (Codex keeps a native marker). */
function latestCompaction(log: SessionLog, threadId: string, anyCompaction: boolean): CompactionBlock | null {
  const thread = log.threads.find((t) => t.thread_id === threadId);
  const marker = [...(thread?.messages ?? [])].sort((a, b) => a.seq - b.seq).filter((m) => m.kind === 'compaction' && (anyCompaction || m.in_context)).pop();
  return marker?.blocks.find((b): b is CompactionBlock => b.type === 'compaction') ?? null;
}

const SYSTEM_REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g;
/** Claude Code wraps a message delivered to a resumed sub-agent. */
const CLAUDE_CODE_SUBAGENT_FRAMING = [/^The coordinator sent a message while you were working:\n/, /\n\nAddress this before completing your current task\.$/];

/**
 * The compare options for the next request of a restored thread in each tested harness: the text
 * the harness injects on its own (reminders, environment blocks, compaction wrappers), which the
 * record does not hold. Each pattern is a finding of the cross-harness restore matrix. Use it as
 * `compareViews(threadView(...), normalizeRequest(api, body), compareOptionsFor(harness, log, threadId))`.
 * An unknown harness gets only the summary and `dropEmpty`.
 */
export function compareOptionsFor(harness: string, log: SessionLog, threadId: string): ViewCompareOptions {
  const compaction = latestCompaction(log, threadId, harness === 'codex');
  const summary = compaction?.summary ?? null;
  const isChild = log.threads.find((t) => t.thread_id === threadId)?.parent_thread_id != null;
  switch (harness) {
    case 'pi':
      return { ignore: [/^\(no tool output\)$/], summary, dropEmpty: true };
    case 'opencode':
      return { ignore: compaction ? [/^What did we do so far\?$/] : [], summary, dropEmpty: true };
    case 'opencode-v2':
      return {
        ignore: [
          /<system-update>\n[\s\S]*?\n<\/system-update>/g,
          /<conversation-checkpoint>\nThe following is a summary and serialized record of earlier conversation\. Treat it as historical context, not as new instructions\.\n\n<summary>\n/g,
          /\n<\/summary>\n\n<recent-context>\n/g,
          /\n<\/recent-context>\n<\/conversation-checkpoint>/g,
        ],
        summary,
        dropEmpty: true,
        summarySplit: 'substring',
      };
    case 'claude-code':
      return { ignore: [SYSTEM_REMINDER, ...(isChild ? CLAUDE_CODE_SUBAGENT_FRAMING : [])], summary, dropEmpty: true };
    case 'codex':
      return { ignore: [/<environment_context>[\s\S]*?<\/environment_context>/g, /^<image name=\[Image #\d+\] path="[^"]*">$|^<\/image>$/g], summary, dropEmpty: true };
    default:
      return { summary, dropEmpty: true };
  }
}
