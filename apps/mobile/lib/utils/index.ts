/**
 * Utility Functions
 *
 * General-purpose utility functions and helpers
 */

// Core utilities
export * from './utils';
export * from './uuid';
export * from './date';
export * from './search';

// Theme & styling
export * from './theme';
export * from './fonts';
export * from './icon-mapping';

// Parsing & formatting
export { formatCredits, formatCreditsWithSign, dollarsToCredits, creditsToDollars, formatDollarsAsCredits, CREDITS_PER_DOLLAR } from '@kortix/shared';

// Tool call utilities
export {
  extractToolCall,
  extractToolResult,
  extractToolCallFromToolMessage,
  extractToolData,
  extractToolCallAndResult,
  type ToolCallData,
} from './tool-data-extractor';

// Domain-specific utilities
export * from './thread-utils';
export * from './trigger-utils';
export * from './model-provider';
export * from './error-handler';

// Type definitions
export * from './auth-types';

// i18n
export * from './i18n';
