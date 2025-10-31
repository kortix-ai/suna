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
  Clock,
  Zap,
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
  if (minute === '*/15' && hour === '*' && dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
    return 'Every 15 minutes';
  }
  if (minute === '*/30' && hour === '*' && dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
    return 'Every 30 minutes';
  }
  if (minute === '0' && hour === '9' && dayOfMonth === '*' && month === '*' && dayOfWeek === '1-5') {
    return 'Weekdays at 9 AM';
  }
  if (minute === '0' && hour === String(hour) && dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
    return `Daily at ${hour}:${minute.padStart(2, '0')}`;
  }

  return cron;
};

/**
 * Get human-readable trigger type name
 */
export const getTriggerTypeName = (triggerType: string): string => {
  switch (triggerType.toLowerCase()) {
    case 'schedule':
    case 'scheduled':
      return 'Schedule';
    case 'telegram':
      return 'Telegram';
    case 'github':
      return 'GitHub';
    case 'slack':
      return 'Slack';
    case 'webhook':
      return 'Webhook';
    case 'discord':
      return 'Discord';
    case 'event':
      return 'Event';
    default:
      return triggerType.charAt(0).toUpperCase() + triggerType.slice(1);
  }
};

/**
 * Get trigger status text
 */
export const getTriggerStatusText = (isActive: boolean): string => {
  return isActive ? 'Active' : 'Inactive';
};

/**
 * Get trigger status color
 */
export const getTriggerStatusColor = (isActive: boolean): string => {
  return isActive ? 'text-green-600' : 'text-gray-500';
};

/**
 * Get trigger status background color
 */
export const getTriggerStatusBgColor = (isActive: boolean): string => {
  return isActive ? 'bg-green-100' : 'bg-gray-100';
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

/**
 * Get webhook URL display text (truncated)
 */
export const getWebhookDisplayUrl = (url?: string, maxLength: number = 50): string => {
  if (!url) return 'No webhook URL';
  
  if (url.length <= maxLength) return url;
  
  const start = url.substring(0, maxLength - 3);
  return `${start}...`;
};

/**
 * Validate cron expression
 */
export const isValidCronExpression = (cron: string): boolean => {
  const cronRegex = /^(\*|([0-5]?\d)) (\*|([01]?\d|2[0-3])) (\*|([012]?\d|3[01])) (\*|([0]?\d|1[0-2])) (\*|([0-6]))$/;
  return cronRegex.test(cron);
};

/**
 * Get common cron presets
 */
export const getCronPresets = () => [
  {
    label: 'Every 15 minutes',
    value: '*/15 * * * *',
    description: 'Runs every 15 minutes',
  },
  {
    label: 'Every 30 minutes',
    value: '*/30 * * * *',
    description: 'Runs every 30 minutes',
  },
  {
    label: 'Every hour',
    value: '0 * * * *',
    description: 'Runs every hour at the top of the hour',
  },
  {
    label: 'Daily at midnight',
    value: '0 0 * * *',
    description: 'Runs once per day at midnight',
  },
  {
    label: 'Weekdays at 9 AM',
    value: '0 9 * * 1-5',
    description: 'Runs Monday through Friday at 9 AM',
  },
  {
    label: 'Custom',
    value: '',
    description: 'Enter a custom cron expression',
  },
];




