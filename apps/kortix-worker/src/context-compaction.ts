import {
  buildSessionContext,
  compact,
  estimateContextTokens,
  estimateTokens,
  prepareCompaction,
  prepareBranchEntries,
  type AgentMessage,
  type Entry,
} from "@earendil-works/pi-agent-core";
import type { Api, Model, Models } from "@earendil-works/pi-ai";
import {
  isCompactionOverflow,
  recoverCompactionOverflow,
} from "./compaction-overflow";

export function transcriptMessagesFromEntries(
  entries: readonly Entry[],
): AgentMessage[] {
  return [...entries]
    .sort((a, b) => a.seq - b.seq)
    .flatMap((entry) => {
      if (entry.type === "message") return [entry.message];
      if (entry.type !== "compaction") return [];
      const details = entry.details as
        { kortixDisplayMessages?: AgentMessage[] } | undefined;
      return details?.kortixDisplayMessages ?? [];
    });
}

export function compactedModelContext(
  messages: AgentMessage[],
  entries: readonly Entry[],
): AgentMessage[] {
  const ordered = [...entries].sort((a, b) => a.seq - b.seq);
  const index = ordered.findLastIndex((entry) => entry.type === "compaction");
  if (index < 0) return messages;
  const prefix = transcriptMessagesFromEntries(ordered.slice(0, index + 1));
  const anchor = prefix.at(-1) as { kortixWireMessageId?: string } | undefined;
  const message = messages[prefix.length - 1] as
    { kortixWireMessageId?: string } | undefined;
  if (
    !anchor?.kortixWireMessageId ||
    message?.kortixWireMessageId !== anchor.kortixWireMessageId
  )
    throw new Error("Compaction context does not match the durable transcript");
  return [
    // Retained messages keep their original usage in the display transcript only.
    ...buildSessionContext([ordered[index]!]).messages.map((message) => {
      if (message.role !== 'assistant') return message;
      return {
        ...message,
        usage: {
          input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };
    }),
    ...messages.slice(prefix.length),
  ];
}

export function contextNeedsCompaction(
  messages: AgentMessage[],
  incoming: AgentMessage,
  model: Model<Api>,
  systemPrompt: string,
  tools: readonly { name: string; description: string; parameters: unknown }[],
): boolean {
  if (
    !messages.length ||
    !Number.isFinite(model.contextWindow) ||
    model.contextWindow <= 0
  )
    return false;
  const estimated = estimateContextTokens(messages).tokens;
  const serialized = messages.reduce(
    (total, message) => total + estimateTokens(message),
    0,
  );
  const instructions = Math.ceil(
    (systemPrompt.length +
      JSON.stringify(
        tools.map(({ name, description, parameters }) => ({
          name,
          description,
          parameters,
        })),
      ).length) /
      3,
  );
  const reserve = Math.min(
    model.contextWindow / 4,
    Math.max(8192, Math.floor(model.contextWindow * 0.15)),
  );
  return (
    Math.max(estimated, serialized + instructions) + estimateTokens(incoming) >=
    model.contextWindow - reserve
  );
}

export async function summarizeContext(
  entries: Entry[],
  models: Models,
  model: Model<Api>,
  signal: AbortSignal,
) {
  const context = buildSessionContext(entries).messages;
  const tokens = context.reduce(
    (total, message) => total + estimateTokens(message),
    0,
  );
  const prepared = prepareCompaction(entries, {
    enabled: true,
    reserveTokens: Math.min(
      8192,
      Math.max(2048, Math.floor(model.contextWindow / 4)),
    ),
    keepRecentTokens:
      tokens < 4096 ? 0 : Math.min(16000, Math.floor(tokens / 4)),
  });
  if (!prepared.ok) throw prepared.error;
  if (!prepared.value)
    throw new Error("No new conversation context to compact");
  let preparation = prepared.value;
  const retainedTokens = preparation.retainedTail.reduce(
    (total, message) => total + estimateTokens(message),
    0,
  );
  // Pi keeps whole tool batches, which can exceed its requested retention budget.
  if (retainedTokens > preparation.settings.keepRecentTokens) {
    const fileOps = prepareBranchEntries(entries).fileOps;
    for (const kind of ['read', 'written', 'edited'] as const) {
      for (const path of preparation.fileOps[kind]) fileOps[kind].add(path);
    }
    preparation = {
      ...preparation,
      messagesToSummarize: [
        ...preparation.messagesToSummarize,
        ...preparation.turnPrefixMessages,
        ...preparation.retainedTail,
      ],
      turnPrefixMessages: [],
      retainedTail: [],
      isSplitTurn: false,
      fileOps,
    };
  }
  signal.throwIfAborted();
  const summaryModels: Models = {
    ...models,
    completeSimple: async (...args) => {
      const response = await models.completeSimple(...args);
      if (response.stopReason !== "length") return response;
      return {
        ...response,
        stopReason: "error",
        errorMessage:
          "Compaction summary reached the output limit; the original conversation was kept",
      };
    },
  };
  const result = await compact(
    preparation,
    summaryModels,
    model,
    undefined,
    signal,
    "off",
  );
  if (!result.ok) {
    if (!isCompactionOverflow(result.error)) throw result.error;
    const allFileOps = prepareBranchEntries(entries).fileOps;
    for (const kind of ['read', 'written', 'edited'] as const) {
      for (const path of preparation.fileOps[kind]) allFileOps[kind].add(path);
    }
    return recoverCompactionOverflow(
      { ...preparation, fileOps: allFileOps },
      summaryModels,
      model,
      signal,
    );
  }
  signal.throwIfAborted();
  if (!result.value.summary.trim())
    throw new Error("The model returned an empty compaction summary");
  return result.value;
}
