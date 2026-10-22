import { type AppIcon } from '@/lib/icons';

/**
 * Conversation Type
 * 
 * Represents a chat conversation in the sidebar
 */
export interface Conversation {
  id: string;
  title: string;
  icon: AppIcon; // Fallback icon component
  iconName?: string | null; // Dynamic icon name from backend
  preview?: string;
  timestamp: Date;
}

/**
 * Conversation Section Type
 * 
 * Groups conversations by time period (e.g., "Today", "Yesterday", "This Week")
 * Note: title is removed - format from timestamp in component
 */
export interface ConversationSection {
  id: string;
  timestamp: Date;
  periodLabel?: string; // Time period key for localization (today, yesterday, thisWeek, etc.)
  conversations: Conversation[];
}
