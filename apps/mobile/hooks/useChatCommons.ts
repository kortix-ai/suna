// Import directly from specific hook files to avoid circular dependency
import { useAgentManager } from './ui/useAgentManager';
import { useAudioRecorder } from './media/useAudioRecorder';
import { useAudioRecordingHandlers } from './media/useAudioRecordingHandlers';
import type { UseChatReturn } from './useChat';

/**
 * useChatCommons Hook
 * 
 * Shared hook logic for HomePage and ThreadPage:
 * - Agent manager (selection and drawer)
 * - Audio recorder (recording state)
 * - Audio handlers (start, cancel, send)
 * - Combined transcription state
 * 
 * This hook extracts common setup from both page components.
 */
export function useChatCommons(chat: UseChatReturn) {
  // Agent manager for drawer and selection
  const agentManager = useAgentManager();
  
  // Audio recording state
  const audioRecorder = useAudioRecorder();
  
  // Audio recording handlers
  const audioHandlers = useAudioRecordingHandlers(
    audioRecorder, 
    agentManager, 
    chat.transcribeAndAddToInput
  );
  
  // Combined transcription state (from either chat or audio handlers)
  const isTranscribing = chat.isTranscribing || audioHandlers.isTranscribing;
  
  return {
    agentManager,
    audioRecorder,
    audioHandlers,
    isTranscribing,
  };
}

