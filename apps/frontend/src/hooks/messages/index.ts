// Message and streaming related hooks
export { useAgentStream, type UseAgentStreamResult, type AgentStreamCallbacks } from './useAgentStream';
export { useThreadToolCalls } from './useThreadToolCalls';
export { useMessagesQuery, useAddUserMessageMutation } from './useMessages';
export { usePlaybackController, type PlaybackState } from './usePlaybackController';

// Smooth text/streaming animation hooks - re-exported from shared package
export { 
  useSmoothText, 
  useSmoothToolField, 
  useSmoothAnimation, 
  type SmoothAnimationConfig,
  type SmoothToolConfig,
} from '@agentpress/shared/animations';

// Message rendering utilities
export * from './utils';

