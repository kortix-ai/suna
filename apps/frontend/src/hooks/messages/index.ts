// Message and streaming related hooks
export { useAgentStream, type UseAgentStreamResult, type AgentStreamCallbacks } from './useAgentStream';
export { useThreadToolCalls } from './useThreadToolCalls';
export { useMessagesQuery, useAddUserMessageMutation } from './useMessages';
export { usePlaybackController, type PlaybackState } from './usePlaybackController';

// Smooth text/streaming animation hooks - re-exported from shared package
export { 
  useSmoothText, 
  type SmoothTextResult,
  useSmoothToolArguments, 
  useSmoothToolField, 
  useSmoothToolContent,
  type SmoothToolArgumentsResult,
  type SmoothToolFieldResult,
  useSmoothAnimation, 
  extractFieldFromArguments,
  type SmoothAnimationConfig,
  type SmoothAnimationState,
  type SmoothAnimationResult,
} from '@agentpress/shared/animations';

// Message rendering utilities
export * from './utils';

