/**
 * Pure grouping/formatting helpers for rendering the ACP transcript — turn
 * segmentation, same-tool/reasoning grouping, reply-context parsing, and
 * duration/cost formatting. Framework-free (no React) so the rules stay
 * testable without mounting a component, mirroring `acp-composer-adapters.ts`.
 */

import type { AcpChatItem, AcpStoredEnvelope, AcpUsageCost } from '@kortix/sdk';
import { acpToolName } from './acp-tool-call-card';

export type AcpMessageItem = Extract<AcpChatItem, { kind: 'message' }>;
export type AcpToolItem = Extract<AcpChatItem, { kind: 'tool' }>;
export type AcpPlanItem = Extract<AcpChatItem, { kind: 'plan' }>;
export type AcpRawItem = Extract<AcpChatItem, { kind: 'raw' }>;

/** Groups a flat ACP item stream into turns — one turn per user message,
 *  with every following item (assistant text, thoughts, tools, plans, raw)
 *  attached until the next user message starts a new turn. */
export function groupAcpTurns(items: readonly AcpChatItem[]): AcpChatItem[][] {
  const turns: AcpChatItem[][] = [];
  for (const item of items) {
    if (item.kind === 'message' && item.role === 'user') turns.push([item]);
    else if (turns.length) turns.at(-1)!.push(item);
    else turns.push([item]);
  }
  return turns;
}

/** Splits a turn into its leading user bubble (if any) and the rest. A turn
 *  that starts with something other than a user message (e.g. orphaned
 *  assistant activity before any prompt) has no bubble at all. */
export function splitAcpTurn(turn: readonly AcpChatItem[]): {
  userItem: AcpMessageItem | null;
  restItems: AcpChatItem[];
} {
  const [first, ...rest] = turn;
  if (first && first.kind === 'message' && first.role === 'user') {
    return { userItem: first, restItems: rest };
  }
  return { userItem: null, restItems: [...turn] };
}

const CONTEXT_TOOLS = new Set(['read', 'glob', 'grep', 'list']);

/** Normalizes a tool name into its grouping bucket — read/glob/grep/list
 *  collapse into one "gathered context" pile, bash into one "ran commands"
 *  pile, everything else groups by its own exact name (e.g. 3x edit). */
export function acpToolGroupKind(toolName: string): string {
  if (CONTEXT_TOOLS.has(toolName)) return '__context__';
  if (toolName === 'bash') return '__shell__';
  return toolName;
}

export type AcpTurnRenderItem =
  | { type: 'reasoning-group'; items: AcpMessageItem[]; key: string }
  | { type: 'tool-group'; groupKind: string; items: AcpToolItem[]; key: string }
  | { type: 'tool-single'; item: AcpToolItem }
  | { type: 'plan'; item: AcpPlanItem }
  | { type: 'raw'; item: AcpRawItem }
  | { type: 'message'; item: AcpMessageItem };

/** Folds a turn's non-user items into render groups: consecutive `thought`
 *  messages collapse into one reasoning card, 2+ consecutive same-bucket
 *  tool calls collapse into one same-tool pile ("Gathered context" / "Ran N
 *  commands" / "Edit · 3x"), singles stay individual — matching main's
 *  `SameToolGroup`/`GroupedReasoningCard` folding rules. Permission/question
 *  items are intentionally dropped: they render pinned above the composer. */
export function groupAcpTurnItems(items: readonly AcpChatItem[]): AcpTurnRenderItem[] {
  const out: AcpTurnRenderItem[] = [];
  let pendingReasoning: AcpMessageItem[] = [];
  let pendingTools: AcpToolItem[] = [];
  let pendingToolKind: string | null = null;

  const flushReasoning = () => {
    if (pendingReasoning.length > 0) {
      out.push({
        type: 'reasoning-group',
        items: pendingReasoning,
        key: `reasoning-${pendingReasoning[0].id}`,
      });
      pendingReasoning = [];
    }
  };
  const flushTools = () => {
    if (pendingTools.length >= 2 && pendingToolKind) {
      out.push({
        type: 'tool-group',
        groupKind: pendingToolKind,
        items: pendingTools,
        key: `tg-${pendingTools[0].id}`,
      });
    } else if (pendingTools.length === 1) {
      out.push({ type: 'tool-single', item: pendingTools[0] });
    }
    pendingTools = [];
    pendingToolKind = null;
  };

  for (const item of items) {
    if (item.kind === 'message' && item.role === 'thought') {
      if (item.text.trim()) {
        flushTools();
        pendingReasoning.push(item);
      }
      continue;
    }
    flushReasoning();

    if (item.kind === 'tool') {
      const groupKind = acpToolGroupKind(acpToolName(item));
      if (pendingToolKind === groupKind) {
        pendingTools.push(item);
      } else {
        flushTools();
        pendingToolKind = groupKind;
        pendingTools = [item];
      }
      continue;
    }
    flushTools();

    if (item.kind === 'plan') out.push({ type: 'plan', item });
    else if (item.kind === 'raw') out.push({ type: 'raw', item });
    else if (item.kind === 'message') out.push({ type: 'message', item });
    // permission/question items render pinned above the composer, not here.
  }
  flushReasoning();
  flushTools();
  return out;
}

// ---------------------------------------------------------------------------
// Reply context — <reply_context> wrapper (mirrors main's select-and-reply)
// ---------------------------------------------------------------------------

const REPLY_CONTEXT_RE = /<reply_context>([\s\S]*?)<\/reply_context>\s*/;

/** Wraps an outgoing prompt with the reply-context XML tag main's transcript
 *  parser expects, so a reply reads back out via `parseAcpReplyContext`. */
export function wrapAcpReplyContext(text: string, replyText: string): string {
  return `<reply_context>${replyText}</reply_context>\n\n${text}`;
}

export function parseAcpReplyContext(text: string): {
  cleanText: string;
  replyContext: string | null;
} {
  const match = text.match(REPLY_CONTEXT_RE);
  if (!match) return { cleanText: text, replyContext: null };
  return { cleanText: text.replace(REPLY_CONTEXT_RE, '').trim(), replyContext: match[1].trim() };
}

// ---------------------------------------------------------------------------
// Turn duration — best-effort from envelope timestamps
// ---------------------------------------------------------------------------

/** ACP item ids for message-kind items embed their originating envelope
 *  ordinal (`prompt-12`, `assistant-15`, `thought-9` — see
 *  `projectAcpChatItems`) — extract it so a turn's wall-clock span can be
 *  read back from the envelope rows without the projection carrying timing
 *  data of its own. */
export function acpItemOrdinal(id: string): number | null {
  const match = id.match(/-(\d+)$/);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

export function acpOrdinalTimestamps(envelopes: readonly AcpStoredEnvelope[]): Map<number, number> {
  const map = new Map<number, number>();
  for (const row of envelopes) {
    const t = row.createdAt ? Date.parse(row.createdAt) : NaN;
    if (Number.isFinite(t)) map.set(row.ordinal, t);
  }
  return map;
}

/** Best-effort turn duration: earliest → latest timestamp among the turn's
 *  message items. Tool calls carry no ordinal-addressable timing in the ACP
 *  projection today, so they don't extend the window. Returns null when
 *  there isn't enough timestamp data to say anything (never renders a
 *  fabricated duration). */
export function acpTurnDurationMs(
  turnItems: readonly AcpChatItem[],
  ordinalTimestamps: ReadonlyMap<number, number>,
): number | null {
  let start: number | null = null;
  let end: number | null = null;
  for (const item of turnItems) {
    if (item.kind !== 'message') continue;
    const ordinal = acpItemOrdinal(item.id);
    if (ordinal == null) continue;
    const t = ordinalTimestamps.get(ordinal);
    if (t == null) continue;
    if (start == null || t < start) start = t;
    if (end == null || t > end) end = t;
  }
  if (start == null || end == null || end <= start) return null;
  return end - start;
}

export function formatAcpDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

export function formatAcpCost(cost: AcpUsageCost | null | undefined): string | null {
  if (!cost || !Number.isFinite(cost.amount)) return null;
  const symbol = cost.currency === 'USD' ? '$' : `${cost.currency} `;
  return `${symbol}${cost.amount < 0.01 ? cost.amount.toFixed(4) : cost.amount.toFixed(2)}`;
}

// ---------------------------------------------------------------------------
// "Gathered context" pile summary — "3 reads, 2 searches"
// ---------------------------------------------------------------------------

export function acpContextGroupSummary(items: readonly AcpToolItem[]): string {
  let read = 0;
  let search = 0;
  let list = 0;
  for (const item of items) {
    const name = acpToolName(item);
    if (name === 'read') read++;
    else if (name === 'grep') search++;
    else if (name === 'glob' || name === 'list') list++;
  }
  const parts: string[] = [];
  if (read > 0) parts.push(`${read} read${read > 1 ? 's' : ''}`);
  if (search > 0) parts.push(`${search} search${search > 1 ? 'es' : ''}`);
  if (list > 0) parts.push(`${list} list${list > 1 ? 's' : ''}`);
  return parts.join(', ');
}
