/**
 * Trigger Utilities
 * 
 * Helper functions for trigger display and formatting
 * Matching frontend trigger-utils.ts functionality
 */

import {
  MessageSquare,
  Github,
  Slack,
  Hash,
  Globe,
  Sparkles,
  Repeat,
  Webhook,
} from 'lucide-react-native';

/**
 * Get icon component for trigger type
 */
export const getTriggerIcon = (triggerType: string | undefined) => {
  if (!triggerType) {
    return Globe; // Default icon
  }
  
  switch (triggerType.toLowerCase()) {
    case 'schedule':
    case 'scheduled':
      return Repeat;
    case 'telegram':
      return MessageSquare;
    case 'github':
      return Github;
    case 'slack':
      return Slack;
    case 'webhook':
      return Webhook;
    case 'discord':
      return Hash;
    case 'event':
      return Sparkles;
    default:
      return Globe;
  }
};

/**
 * Get trigger category (scheduled or app)
 */
export const getTriggerCategory = (triggerType: string): 'scheduled' | 'app' => {
  const scheduledTypes = ['schedule', 'scheduled'];
  return scheduledTypes.includes(triggerType.toLowerCase()) ? 'scheduled' : 'app';
};

/**
 * Format cron expression to human-readable text
 */
export const formatCronExpression = (cron?: string): string => {
  if (!cron) return 'Not configured';

  const parts = cron.split(' ');
  if (parts.length !== 5) return cron;

  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;

  // Common patterns
  if (minute === '0' && hour === '0' && dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
    return 'Daily at midnight';
  }
  if (minute === '0' && hour === '*/1' && dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
    return 'Every hour';
  }
  // Removed: schedules under 1 hour are no longer allowed
  if (minute === '0' && hour === '9' && dayOfMonth === '*' && month === '*' && dayOfWeek === '1-5') {
    return 'Weekdays at 9 AM';
  }
  if (minute === '0' && hour === String(hour) && dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
    return `Daily at ${hour}:${minute.padStart(2, '0')}`;
  }

  return cron;
};

/**
 * Format trigger creation date
 */
export const formatTriggerDate = (dateString: string): string => {
  const date = new Date(dateString);
  const now = new Date();
  const diffInHours = Math.floor((now.getTime() - date.getTime()) / (1000 * 60 * 60));

  if (diffInHours < 1) {
    return 'Just now';
  } else if (diffInHours < 24) {
    return `${diffInHours}h ago`;
  } else if (diffInHours < 24 * 7) {
    const days = Math.floor(diffInHours / 24);
    return `${days}d ago`;
  } else {
    return date.toLocaleDateString();
  }
};
