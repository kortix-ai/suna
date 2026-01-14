/**
 * Canvas tool utilities - re-exports from @agentpress/kanvax
 *
 * This file re-exports types and utilities from the kanvax package
 * for backwards compatibility with existing imports.
 */

// Re-export types from @agentpress/kanvax for backwards compatibility
export type {
  CanvasElement,
  CanvasData,
  ExtractedCanvasData,
} from '@agentpress/kanvax/core';

// Re-export utilities from @agentpress/kanvax
export {
  extractCanvasData,
  isCanvasFile,
  parseCanvasFilePath,
} from '@agentpress/kanvax/core';
