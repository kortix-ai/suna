import type { LucideIcon } from 'lucide-react-native';

/**
 * Conversation Type
 * 
 * Represents a chat conversation in the sidebar
 */
export interface Conversation {
  id: string;
  title: string;
  icon: LucideIcon; // Fallback icon component
  iconName?: string | null; // Dynamic icon name from backend
  preview?: string;
  timestamp: Date;
}

/**
 * Conversation Section Type
 * 
 * Groups conversations by time period (e.g., "August", "July")
 * Note: title is removed - format from timestamp in component
 */
export interface ConversationSection {
  id: string;
  timestamp: Date;
  conversations: Conversation[];
}

/**
 * Bottom Nav Item Type
 * 
 * Navigation items in the bottom menu
 */
export interface BottomNavItem {
  id: string;
  icon: LucideIcon;
  label: string;
  onPress: () => void;
}

/**
 * Tier Type
 * 
 * Available subscription tiers
 */
export type TierType = 'Basic' | 'Plus' | 'Pro' | 'Ultra';

/**
 * User Profile Type
 * 
 * User information for profile section
 */
export interface UserProfile {
  id: string;
  name: string;
  email: string;
  avatar?: string;
  tier?: TierType;
  planName?: string; // Plan name from subscription (e.g., 'Plus', 'Pro', 'Ultra')
}

