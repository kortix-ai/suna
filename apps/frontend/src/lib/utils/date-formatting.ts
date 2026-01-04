/**
 * Format a date string for display in sidebar lists
 * Shows "how long ago" relative to now
 * Works with group headers that already show "Today", "Yesterday", "This Week", etc.
 * 
 * @param dateString - ISO date string to format
 * @returns Formatted date string (e.g., "5m ago", "2h ago", "Mon", "Dec 25")
 */
export function formatDateForList(dateString: string): string {
  const date = new Date(dateString);
  const now = new Date();
  
  // Get start of today (midnight)
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  
  // Get start of date (midnight)
  const startOfDate = new Date(date);
  startOfDate.setHours(0, 0, 0, 0);
  
  // Calculate difference in days (calendar days, not 24-hour periods)
  const diffDays = Math.floor((startOfToday.getTime() - startOfDate.getTime()) / (1000 * 60 * 60 * 24));
  
  // If it's today, show relative time
  if (diffDays === 0) {
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / (1000 * 60));
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
    
    if (diffMins < 60) {
      return diffMins === 0 ? 'now' : `${diffMins}m`;
    }
    return `${diffHours}h`;
  }

  // This week (1-7 days): show day name
  if (diffDays <= 7) {
    return date.toLocaleDateString('en-US', { weekday: 'short' });
  }

  // Older: show month and day
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
