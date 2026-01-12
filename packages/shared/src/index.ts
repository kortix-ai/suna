/**
 * @agentpress/shared
 * 
 * Shared code between frontend (Next.js) and mobile (React Native) applications.
 * This package contains platform-agnostic types, utilities, and business logic.
 * 
 * @example
 * // Import types
 * import type { UnifiedMessage, ParsedContent } from '@agentpress/shared/types';
 * 
 * // Import streaming utilities
 * import { extractTextFromPartialJson, isAskOrCompleteTool } from '@agentpress/shared/streaming';
 * 
 * // Import tool utilities
 * import { getUserFriendlyToolName, getToolIconKey } from '@agentpress/shared/tools';
 * 
 * // Import general utilities
 * import { safeJsonParse, groupMessages } from '@agentpress/shared/utils';
 * 
 * // Import animation utilities
 * import { useSmoothText, useSmoothToolField } from '@agentpress/shared/animations';
 */

// Re-export everything for convenience
export * from './types';
export * from './streaming';
export * from './tools';
export * from './utils';
export * from './animations';
export * from './constants/upload-limits';

