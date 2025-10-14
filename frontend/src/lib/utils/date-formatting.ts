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
  
  // Calculate difference in milliseconds
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / (1000 * 60));
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  // Less than 1 hour: show minutes
  if (diffMins < 60) {
    return diffMins === 0 ? 'now' : `${diffMins}m`;
  }

  // Less than 24 hours (Today): show hours
  if (diffHours < 24) {
    return `${diffHours}h`;
  }

  // This week (1-7 days): show day name
  if (diffDays <= 7) {
    return date.toLocaleDateString('en-US', { weekday: 'short' });
  }

  // This month (8-30 days): show month and day
  if (diffDays <= 30) {
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }

  // Older: show month and day
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
