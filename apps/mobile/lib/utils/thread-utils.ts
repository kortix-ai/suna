/**
 * Thread Utilities
 * 
 * Transform backend thread data into UI-friendly formats
 */

import { MessageCircle } from 'lucide-react-native';
import type { Thread } from '@/api/types';
import type { Conversation, ConversationSection } from '@/components/menu/types';

/**
 * Groups threads by month for display in the menu
 */
export function groupThreadsByMonth(threads: Thread[]): ConversationSection[] {
  if (!threads || threads.length === 0) {
    return [];
  }

  // Sort threads by created_at descending (newest first)
  const sortedThreads = [...threads].sort((a, b) => {
    return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
  });

  // Group by year-month
  const grouped = new Map<string, Thread[]>();
  
  sortedThreads.forEach(thread => {
    const date = new Date(thread.created_at);
    const monthKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
    
    if (!grouped.has(monthKey)) {
      grouped.set(monthKey, []);
    }
    grouped.get(monthKey)!.push(thread);
  });

  // Convert to ConversationSection format
  return Array.from(grouped.entries()).map(([key, threads]) => ({
    id: key,
    timestamp: new Date(threads[0].created_at), // Use first thread's date for section timestamp
    conversations: threads.map(threadToConversation),
  }));
}

/**
 * Converts a Thread to a Conversation for UI display
 */
function threadToConversation(thread: Thread): Conversation {
  return {
    id: thread.thread_id,
    title: thread.project?.name || thread.title || 'Untitled Chat',
    icon: MessageCircle, // Fallback icon
    iconName: thread.project?.icon_name, // Dynamic icon from project
    timestamp: new Date(thread.created_at),
  };
}

/**
 * Gets an appropriate icon for a thread based on its content
 * Currently returns default icon, but can be extended to analyze thread content
 */
export function getThreadIcon(thread: Thread) {
  // Future: Analyze thread.project.name or first message to determine icon
  // For now, use default MessageCircle
  return MessageCircle;
}

