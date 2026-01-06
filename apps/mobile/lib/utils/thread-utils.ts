/**
 * Thread Utilities
 * 
 * Transform backend thread data into UI-friendly formats
 */

import { MessageCircle } from 'lucide-react-native';
import type { Thread, Agent } from '@/api/types';
import type { Conversation, ConversationSection } from '@/components/menu/types';

/**
 * Time period keys for relative grouping
 */
type TimePeriod = 'today' | 'yesterday' | 'thisWeek' | 'thisMonth' | 'older';

/**
 * Get the time period key for a given date
 */
function getTimePeriod(date: Date): TimePeriod {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const weekAgo = new Date(today);
  weekAgo.setDate(weekAgo.getDate() - 7);
  const monthAgo = new Date(today);
  monthAgo.setMonth(monthAgo.getMonth() - 1);

  const targetDay = new Date(date.getFullYear(), date.getMonth(), date.getDate());

  if (targetDay.getTime() >= today.getTime()) {
    return 'today';
  }
  if (targetDay.getTime() >= yesterday.getTime()) {
    return 'yesterday';
  }
  if (targetDay.getTime() >= weekAgo.getTime()) {
    return 'thisWeek';
  }
  if (targetDay.getTime() >= monthAgo.getTime()) {
    return 'thisMonth';
  }
  return 'older';
}

/**
 * Get localized label for time period
 */
function getTimePeriodLabel(period: TimePeriod, locale: string = 'en'): string {
  const labels: Record<string, Record<TimePeriod, string>> = {
    en: { today: 'Today', yesterday: 'Yesterday', thisWeek: 'This Week', thisMonth: 'This Month', older: 'Older' },
    es: { today: 'Hoy', yesterday: 'Ayer', thisWeek: 'Esta Semana', thisMonth: 'Este Mes', older: 'Anteriores' },
    fr: { today: "Aujourd'hui", yesterday: 'Hier', thisWeek: 'Cette Semaine', thisMonth: 'Ce Mois', older: 'Anciens' },
    de: { today: 'Heute', yesterday: 'Gestern', thisWeek: 'Diese Woche', thisMonth: 'Diesen Monat', older: 'Älter' },
    zh: { today: '今天', yesterday: '昨天', thisWeek: '本周', thisMonth: '本月', older: '更早' },
    ja: { today: '今日', yesterday: '昨日', thisWeek: '今週', thisMonth: '今月', older: '以前' },
    pt: { today: 'Hoje', yesterday: 'Ontem', thisWeek: 'Esta Semana', thisMonth: 'Este Mês', older: 'Anteriores' },
    it: { today: 'Oggi', yesterday: 'Ieri', thisWeek: 'Questa Settimana', thisMonth: 'Questo Mese', older: 'Precedenti' },
  };

  return labels[locale]?.[period] || labels['en'][period];
}

/**
 * Groups threads by relative time period for display in the menu
 */
export function groupThreadsByMonth(threads: Thread[]): ConversationSection[] {
  if (!threads || threads.length === 0) {
    return [];
  }

  // Sort threads by created_at descending (newest first)
  const sortedThreads = [...threads].sort((a, b) => {
    return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
  });

  // Group by time period
  const periodOrder: TimePeriod[] = ['today', 'yesterday', 'thisWeek', 'thisMonth', 'older'];
  const grouped = new Map<TimePeriod, Thread[]>();
  
  sortedThreads.forEach(thread => {
    const date = new Date(thread.created_at);
    const period = getTimePeriod(date);
    
    if (!grouped.has(period)) {
      grouped.set(period, []);
    }
    grouped.get(period)!.push(thread);
  });

  // Convert to ConversationSection format, maintaining order
  return periodOrder
    .filter(period => grouped.has(period))
    .map(period => {
      const periodThreads = grouped.get(period)!;
      return {
        id: period,
        timestamp: new Date(periodThreads[0].created_at),
        periodLabel: period, // Store the period key for localization
        conversations: periodThreads.map(threadToConversation),
      };
    });
}

/**
 * Groups agents by relative time period for display in the Library tab
 */
export function groupAgentsByTimePeriod(agents: Agent[], locale: string = 'en'): { id: string; label: string; agents: Agent[] }[] {
  if (!agents || agents.length === 0) {
    return [];
  }

  // Sort agents by created_at descending (newest first)
  const sortedAgents = [...agents].sort((a, b) => {
    return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
  });

  // Group by time period
  const periodOrder: TimePeriod[] = ['today', 'yesterday', 'thisWeek', 'thisMonth', 'older'];
  const grouped = new Map<TimePeriod, Agent[]>();
  
  sortedAgents.forEach(agent => {
    const date = new Date(agent.created_at);
    const period = getTimePeriod(date);
    
    if (!grouped.has(period)) {
      grouped.set(period, []);
    }
    grouped.get(period)!.push(agent);
  });

  // Convert to section format, maintaining order
  return periodOrder
    .filter(period => grouped.has(period))
    .map(period => ({
      id: period,
      label: getTimePeriodLabel(period, locale),
      agents: grouped.get(period)!,
    }));
}

export { getTimePeriodLabel };

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

