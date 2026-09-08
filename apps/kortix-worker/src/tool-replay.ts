import type { Agent, AgentMessage } from '@earendil-works/pi-agent-core';
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type ToolResultMessage,
} from '@earendil-works/pi-ai';
interface ToolCheckpoint {
  turnMessageId: string;
  toolCallId: string;
  released: boolean;
  request: { tool?: { messageID: string; callID: string } };
}

interface SavedAssistant extends AssistantMessage {
  kortixWireMessageId?: string;
  kortixParentMessageId?: string;
  kortixWirePartIds?: string[];
}

export interface ToolReplayPlan {
  assistantIndex: number;
  assistant: SavedAssistant;
  results: Map<string, ToolResultMessage>;
  completedSteps: number;
}

export function planToolReplay(
  messages: readonly AgentMessage[],
  checkpoint: ToolCheckpoint,
  validateTool: (tool: { name: string; arguments: Record<string, any> }) => boolean = () => true,
  label = 'tool',
): ToolReplayPlan {
  const fail = (): never => {
    throw new Error(`${label} replay does not match the durable tool boundary`);
  };
  if (checkpoint.released) return fail();
  const assistantIndex = messages.findIndex(
    (message) =>
      message.role === 'assistant' &&
      (message as SavedAssistant).kortixWireMessageId === checkpoint.request.tool?.messageID,
  );
  if (assistantIndex < 1) return fail();
  const assistant = messages[assistantIndex] as SavedAssistant;
  if (
    assistant.kortixParentMessageId !== checkpoint.turnMessageId ||
    assistant.stopReason !== 'toolUse'
  )
    return fail();
  const calls = assistant.content.filter((part) => part.type === 'toolCall');
  if (new Set(calls.map((call) => call.id)).size !== calls.length) return fail();
  const toolIndex = calls.findIndex((call) => call.id === checkpoint.toolCallId);
  const tool = calls[toolIndex];
  if (!tool || !validateTool(tool)) return fail();
  const blockIndex = assistant.content
    .filter(
      (part) =>
        part.type === 'toolCall' ||
        (part.type === 'thinking' && part.thinking.length > 0) ||
        (part.type === 'text' && part.text.length > 0),
    )
    .indexOf(tool);
  const partId =
    assistant.kortixWirePartIds?.[blockIndex] ?? `${assistant.kortixWireMessageId}-p${blockIndex}`;
  if (partId !== checkpoint.request.tool?.callID) return fail();
  const following = messages.slice(assistantIndex + 1);
  if (following.length !== toolIndex) return fail();
  const results = new Map<string, ToolResultMessage>();
  for (const [index, result] of following.entries()) {
    if (
      result.role !== 'toolResult' ||
      result.toolCallId !== calls[index]?.id ||
      result.toolName !== calls[index]?.name
    )
      return fail();
    results.set(result.toolCallId, structuredClone(result));
  }
  const completedSteps = messages
    .slice(0, assistantIndex + 1)
    .filter(
      (message) =>
        message.role === 'assistant' &&
        (message as SavedAssistant).kortixParentMessageId === checkpoint.turnMessageId,
    ).length;
  return { assistantIndex, assistant: structuredClone(assistant), results, completedSteps };
}

export function hasIncompleteToolHistory(messages: readonly AgentMessage[]): boolean {
  const pending = new Map<string, string>();
  for (const message of messages) {
    if (message.role === 'toolResult') {
      if (pending.get(message.toolCallId) !== message.toolName) return true;
      pending.delete(message.toolCallId);
      continue;
    }
    if (pending.size) return true;
    if (message.role !== 'assistant') continue;
    for (const part of message.content) {
      if (part.type !== 'toolCall') continue;
      if (pending.has(part.id)) return true;
      pending.set(part.id, part.name);
    }
  }
  return pending.size > 0;
}

export function completedToolCalls(
  messages: readonly AgentMessage[],
): Array<{ name: string; input: unknown }> {
  const calls: Array<{ name: string; input: unknown }> = [];
  let batch = new Map<string, { name: string; input: unknown }>();
  for (const message of messages) {
    if (message.role === 'user') {
      calls.length = 0;
      batch.clear();
    } else if (message.role === 'assistant') {
      batch = new Map(
        message.content
          .filter((part) => part.type === 'toolCall')
          .map((part) => [part.id, { name: part.name, input: part.arguments }]),
      );
    } else if (message.role === 'toolResult') {
      const call = batch.get(message.toolCallId);
      if (call && call.name === message.toolName) calls.push(call);
    }
  }
  return calls;
}

export function installToolReplay(
  agent: Agent,
  plan: ToolReplayPlan,
  onCachedTool?: (name: string, input: unknown) => void,
) {
  const stream = agent.streamFunction;
  const tools = agent.state.tools;
  const before = agent.beforeToolCall;
  const after = agent.afterToolCall;
  let replay = true;
  let replayingBatch = true;
  agent.streamFunction = (model, context, options) => {
    if (!replay) return stream(model, context, options);
    replay = false;
    const events = createAssistantMessageEventStream();
    events.push({ type: 'done', reason: 'toolUse', message: structuredClone(plan.assistant) });
    events.end();
    return events;
  };
  agent.state.tools = tools.map((tool) => ({
    ...tool,
    execute: (id, params, signal, update) => {
      const cached = replayingBatch ? plan.results.get(id) : undefined;
      if (cached) onCachedTool?.(tool.name, params);
      return cached
        ? Promise.resolve({
            content: structuredClone(cached.content),
            details: structuredClone(cached.details),
          })
        : tool.execute(id, params, signal, update);
    },
  }));
  agent.beforeToolCall = (context, signal) =>
    replayingBatch && plan.results.has(context.toolCall.id)
      ? Promise.resolve(undefined)
      : (before?.(context, signal) ?? Promise.resolve(undefined));
  agent.afterToolCall = (context, signal) => {
    const cached = replayingBatch ? plan.results.get(context.toolCall.id) : undefined;
    return cached
      ? Promise.resolve({
          content: structuredClone(cached.content),
          details: structuredClone(cached.details),
          isError: cached.isError,
        })
      : (after?.(context, signal) ?? Promise.resolve(undefined));
  };
  agent.state.messages = agent.state.messages.slice(0, plan.assistantIndex);
  return {
    normalizeEvent(event: any) {
      if (!replayingBatch) return;
      if (event.message?.role === 'toolResult') {
        const cached = plan.results.get(event.message.toolCallId);
        if (cached) Object.assign(event.message, structuredClone(cached));
      }
      if (event.toolCallId && plan.results.has(event.toolCallId))
        event.kortixCachedToolReplay = true;
      if (event.type === 'turn_end') replayingBatch = false;
    },
    close() {
      agent.streamFunction = stream;
      agent.state.tools = tools;
      agent.beforeToolCall = before;
      agent.afterToolCall = after;
    },
  };
}
