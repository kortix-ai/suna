/**
 * Date Formatting Utilities
 * 
 * Locale-aware date formatting based on current language
 */

/**
 * Format a date for conversation list display
 * Shows relative time for recent dates, absolute for older ones
 * 
 * Examples:
 * - Today: "Today"
 * - Yesterday: "Yesterday"
 * - This week: "Mon", "Tue", etc.
 * - Older: "8/24", "12/25", etc.
 */
export function formatConversationDate(timestamp: Date, locale: string = 'en'): string {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const lastWeek = new Date(today);
  lastWeek.setDate(lastWeek.getDate() - 7);
  
  const targetDate = new Date(timestamp);
  const targetDay = new Date(targetDate.getFullYear(), targetDate.getMonth(), targetDate.getDate());
  
  // Check if today
  if (targetDay.getTime() === today.getTime()) {
    return getLocalizedString('today', locale);
  }
  
  // Check if yesterday
  if (targetDay.getTime() === yesterday.getTime()) {
    return getLocalizedString('yesterday', locale);
  }
  
  // Check if within last 7 days - show day name
  if (targetDay.getTime() > lastWeek.getTime()) {
    return targetDate.toLocaleDateString(locale, { weekday: 'short' });
  }
  
  // Older dates - show numeric format
  return targetDate.toLocaleDateString(locale, { month: 'numeric', day: 'numeric' });
}

/**
 * Format a full date with month name
 * Used for section headers
 * 
 * Examples:
 * - en: "August 2024", "July 2024"
 * - es: "agosto de 2024", "julio de 2024"
 * - fr: "août 2024", "juillet 2024"
 * - de: "August 2024", "Juli 2024"
 * - zh: "2024年8月", "2024年7月"
 * - ja: "2024年8月", "2024年7月"
 */
export function formatMonthYear(timestamp: Date, locale: string = 'en'): string {
  // For current year, just show month name
  const now = new Date();
  const isCurrentYear = timestamp.getFullYear() === now.getFullYear();
  
  if (isCurrentYear) {
    return timestamp.toLocaleDateString(locale, { month: 'long' });
  }
  
  return timestamp.toLocaleDateString(locale, { month: 'long', year: 'numeric' });
}

/**
 * Format a complete date and time
 * Used for message timestamps
 * 
 * Examples:
 * - en: "Aug 27, 2024 at 3:45 PM"
 * - es: "27 ago 2024 a las 15:45"
 */
export function formatDateTime(timestamp: Date, locale: string = 'en'): string {
  return timestamp.toLocaleString(locale, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/**
 * Helper to get localized relative time strings
 */
function getLocalizedString(key: 'today' | 'yesterday', locale: string): string {
  const strings: Record<string, Record<string, string>> = {
    en: { today: 'Today', yesterday: 'Yesterday' },
    es: { today: 'Hoy', yesterday: 'Ayer' },
    fr: { today: 'Aujourd\'hui', yesterday: 'Hier' },
    de: { today: 'Heute', yesterday: 'Gestern' },
    zh: { today: '今天', yesterday: '昨天' },
    ja: { today: '今日', yesterday: '昨日' },
  };
  
  return strings[locale]?.[key] || strings['en'][key];
}

