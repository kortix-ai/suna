/**
 * Thread utilities for rendering tool calls and messages
 */

// Re-export shared utilities (used by KortixComputer Desktop/Dock)
export { getUserFriendlyToolName } from '@kortix/shared';

// Re-export getToolIcon from frontend icon resolver
export { getToolIcon } from '@/lib/icons/tool-icons';

// Frontend-specific flags
export const HIDE_BROWSER_TAB = true;
