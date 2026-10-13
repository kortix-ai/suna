/**
 * One thread's cost, message counts, token totals and context reply: what a context modal's
 * overview and its sub-agent rows read. The cost prices every reply's own `usage` (its `cost`
 * as reported, else the lookup), turn by turn (`sessionLogTurns`, so a compaction's summary
 * reply is priced like any reply); the tokens are every priced reply's usage, summed. This is
 * not `SessionLogTurn.cost`, which prices a v1-derived turn over its v1 parts as `getTurnCost` does. `context` is the last reply with tokens: its usage is the context size.
 *
 * Counts follow the v1 rows a converted record came from: a compaction message is the v1
 * user marker plus, once the compaction is no longer streaming, the summary reply it folded
 * in, so the numbers match a raw v1 explorer. A `system` message is not counted.
 */
import type { ModelPricingLookup } from '../../turns/types';
import type { SessionLogMessage, SessionLogThread } from '../types';
import { sessionLogTurns, usageCostOf } from './turn';

export interface SessionLogThreadMetrics {
  /** USD, with the platform markup: every reply's usage priced. */
  cost: number;
  messages: { all: number; user: number; assistant: number };
  tokens: { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number };
  /** The last reply (an assistant message or a compaction) with tokens: its `usage` is the context size. */
  context: SessionLogMessage | null;
}

export function sessionLogThreadMetrics(
  thread: SessionLogThread,
  options: { pricing?: ModelPricingLookup } = {},
): SessionLogThreadMetrics {
  const m: SessionLogThreadMetrics = {
    cost: 0,
    messages: { all: 0, user: 0, assistant: 0 },
    tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    context: null,
  };
  for (const turn of sessionLogTurns(thread)) {
    const cost = usageCostOf([turn.user, ...turn.assistant], options.pricing);
    if (!cost) continue;
    m.cost += cost.cost;
    for (const k of Object.keys(m.tokens) as Array<keyof SessionLogThreadMetrics['tokens']>) m.tokens[k] += cost.tokens[k];
  }
  for (const msg of thread.messages) {
    if (msg.role === 'user') m.messages.user++;
    else if (msg.role === 'assistant') m.messages.assistant++;
    if (msg.kind === 'compaction' && msg.status !== 'streaming') m.messages.assistant++;
    const u = msg.usage;
    if ((msg.role === 'assistant' || msg.kind === 'compaction') && u && u.input + u.output + (u.reasoning ?? 0) + u.cache_read + u.cache_write > 0) m.context = msg;
  }
  m.messages.all = m.messages.user + m.messages.assistant;
  return m;
}
