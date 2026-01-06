// Message and streaming related hooks
export { useAgentStream, type UseAgentStreamResult, type AgentStreamCallbacks } from './useAgentStream';
export { useThreadToolCalls } from './useThreadToolCalls';
export { useMessagesQuery, useAddUserMessageMutation } from './useMessages';
export { usePlaybackController, type PlaybackState } from './usePlaybackController';

// Smooth text/streaming animation hooks
export { useSmoothText, type SmoothTextResult } from './useSmoothText';
export { 
  useSmoothToolArguments, 
  useSmoothToolField, 
  useSmoothToolContent,
  type SmoothToolArgumentsResult,
  type SmoothToolFieldResult,
} from './useSmoothToolArguments';
export { 
  useSmoothAnimation, 
  extractFieldFromArguments,
  type SmoothAnimationConfig,
  type SmoothAnimationState,
  type SmoothAnimationResult,
} from './useSmoothAnimation';

// Message rendering utilities
export * from './utils';

