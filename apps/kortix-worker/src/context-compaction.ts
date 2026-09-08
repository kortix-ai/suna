import {
  buildSessionContext,
  compact,
  estimateContextTokens,
  prepareCompaction,
  type AgentMessage,
  type Entry,
} from '@earendil-works/pi-agent-core';
import type { Api, Model, Models } from '@earendil-works/pi-ai';

export function transcriptMessagesFromEntries(entries: readonly Entry[]): AgentMessage[] {
  return [...entries]
    .sort((a, b) => a.seq - b.seq)
    .flatMap((entry) => {
      if (entry.type === 'message') return [entry.message];
      if (entry.type !== 'compaction') return [];
      const details = entry.details as { kortixDisplayMessages?: AgentMessage[] } | undefined;
      return details?.kortixDisplayMessages ?? [];
    });
}

export function compactedModelContext(
  messages: AgentMessage[],
  entries: readonly Entry[],
): AgentMessage[] {
  const ordered = [...entries].sort((a, b) => a.seq - b.seq);
  const index = ordered.findLastIndex((entry) => entry.type === 'compaction');
  if (index < 0) return messages;
  const prefix = transcriptMessagesFromEntries(ordered.slice(0, index + 1));
  const anchor = prefix.at(-1) as { kortixWireMessageId?: string } | undefined;
  const message = messages[prefix.length - 1] as { kortixWireMessageId?: string } | undefined;
  if (!anchor?.kortixWireMessageId || message?.kortixWireMessageId !== anchor.kortixWireMessageId)
    throw new Error('Compaction context does not match the durable transcript');
  return [...buildSessionContext([ordered[index]!]).messages, ...messages.slice(prefix.length)];
}

export async function summarizeContext(
  entries: Entry[],
  models: Models,
  model: Model<Api>,
  signal: AbortSignal,
) {
  const context = buildSessionContext(entries).messages;
  const tokens = estimateContextTokens(context).tokens;
  const prepared = prepareCompaction(entries, {
    enabled: true,
    reserveTokens: Math.min(8192, Math.max(2048, Math.floor(model.contextWindow / 4))),
    keepRecentTokens: tokens < 4096 ? 0 : Math.min(16000, Math.floor(tokens / 4)),
  });
  if (!prepared.ok) throw prepared.error;
  if (!prepared.value) throw new Error('No new conversation context to compact');
  signal.throwIfAborted();
  const result = await compact(prepared.value, models, model, undefined, signal, 'off');
  if (!result.ok) throw result.error;
  signal.throwIfAborted();
  if (!result.value.summary.trim())
    throw new Error('The model returned an empty compaction summary');
  return result.value;
}
