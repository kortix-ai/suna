/**
 * Main Hooks Exports
 * 
 * Organized by category for better code organization
 */

// Main chat hook - SINGLE SOURCE OF TRUTH
export { useChat } from './useChat';
export type { UseChatReturn, Attachment } from './useChat';

// API/Data hooks (internal React Query hooks)
export * from './api';

// UI state management
export * from './ui';

// Media/Audio
export * from './media';

// Auth hooks (kept at root for now)
export * from './useAuth';
export * from './useAuthDrawer';
export * from './useNavigation';
