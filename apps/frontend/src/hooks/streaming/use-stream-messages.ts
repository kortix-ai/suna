import { useCallback, useRef } from "react";
import {
  validateStreamMessage,
  StreamMessageType,
  type ChunkMessage,
  type StatusMessage,
  type ToolCallStreamMessage,
  type ToolOutputMessage,
  type UnifiedMessage,
} from "@agentpress/shared";
import { UseStreamStateResult } from "./use-stream-state";
import { UseToolCallAccumulatorResult } from "./use-tool-call-accumulator";

export interface AgentStreamCallbacks {
  onMessage: (message: UnifiedMessage) => void;
  onStatusChange?: (status: string) => void;
  onError?: (error: string) => void;
  onClose?: (finalStatus: string) => void;
  onAssistantStart?: () => void;
  onAssistantChunk?: (chunk: { content: string }) => void;
  onToolCallChunk?: (message: UnifiedMessage) => void;
  onToolOutputStream?: (data: { tool_call_id: string; tool_name: string; output: string; is_final: boolean }) => void;
}

export interface UseStreamMessagesResult {
  handleMessage: (data: string) => void;
  handleError: (error: Error) => void;
  handleClose: () => void;
}

export function useStreamMessages(
  callbacks: AgentStreamCallbacks,
  state: UseStreamStateResult,
  toolCalls: UseToolCallAccumulatorResult,
): UseStreamMessagesResult {
  const callbacksRef = useRef(callbacks);
  callbacksRef.current = callbacks;
  
  const handleMessage = useCallback((data: string) => {
    try {
      let jsonData: unknown;
      if (data.startsWith("data: ")) {
        jsonData = JSON.parse(data.slice(6));
      } else {
        jsonData = JSON.parse(data);
      }
      
      const message = validateStreamMessage(jsonData);
      if (!message) {
        const obj = jsonData as Record<string, unknown>;
        if (obj.type === "assistant" && obj.content) {
          const contentObj = typeof obj.content === "string" ? JSON.parse(obj.content) : obj.content;
          if (contentObj.content) {
            const chunk: ChunkMessage = {
              type: StreamMessageType.CHUNK,
              content: contentObj.content,
              thread_id: (obj.thread_id as string) || "",
              sequence: obj.sequence as number | undefined,
            };
            state.appendChunk(chunk);
            callbacksRef.current.onAssistantChunk?.({ content: contentObj.content });
          }
        }
        return;
      }
      
      switch (message.type) {
        case StreamMessageType.CHUNK:
          const chunk = message as ChunkMessage;
          state.appendChunk(chunk);
          callbacksRef.current.onAssistantChunk?.({ content: chunk.content });
          state.setStatus("streaming");
          break;
          
        case StreamMessageType.STATUS:
          const statusMsg = message as StatusMessage;
          state.setStatus(statusMsg.status);
          callbacksRef.current.onStatusChange?.(statusMsg.status);
          
          if (["completed", "stopped", "failed", "error"].includes(statusMsg.status)) {
            callbacksRef.current.onClose?.(statusMsg.status);
          }
          break;
          
        case StreamMessageType.TOOL_CALL:
          const toolCallMsg = message as ToolCallStreamMessage;
          toolCalls.handleToolCallDelta(toolCallMsg);
          if (toolCalls.current) {
            callbacksRef.current.onToolCallChunk?.(toolCalls.current);
          }
          break;
          
        case StreamMessageType.TOOL_OUTPUT:
          const toolOutputMsg = message as ToolOutputMessage;
          toolCalls.handleToolOutput(toolOutputMsg);
          callbacksRef.current.onToolOutputStream?.({
            tool_call_id: toolOutputMsg.tool_call_id,
            tool_name: toolOutputMsg.tool_name,
            output: toolOutputMsg.output,
            is_final: toolOutputMsg.is_final ?? false,
          });
          break;
          
        case StreamMessageType.LLM_RESPONSE_START:
          callbacksRef.current.onAssistantStart?.();
          break;
          
        case StreamMessageType.ERROR:
          const errorMsg = message as { error?: string; message?: string };
          state.setError(errorMsg.error || errorMsg.message || "Unknown error");
          state.setStatus("error");
          callbacksRef.current.onError?.(errorMsg.error || errorMsg.message || "Unknown error");
          break;
          
        case StreamMessageType.PING:
          break;
      }
    } catch (error) {
      console.error("Error parsing stream message:", error);
      callbacksRef.current.onError?.(error instanceof Error ? error.message : "Failed to parse message");
    }
  }, [state, toolCalls]);
  
  const handleError = useCallback((error: Error) => {
    state.setError(error.message);
    state.setStatus("error");
    callbacksRef.current.onError?.(error.message);
  }, [state]);
  
  const handleClose = useCallback(() => {
    callbacksRef.current.onClose?.("disconnected");
  }, []);
  
  return { handleMessage, handleError, handleClose };
}
