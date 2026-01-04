import { flag } from 'flags/next';
import { getAll } from '@vercel/edge-config';

export type IMaintenanceNotice =
  | {
      enabled: true;
      startTime: string; // Date
      endTime: string; // Date
    }
  | {
      enabled: false;
      startTime?: undefined;
      endTime?: undefined;
    };

export type ITechnicalIssue =
  | {
      enabled: true;
      message: string;
      statusUrl?: string;
      affectedServices?: string[];
      description?: string;
      estimatedResolution?: string;
      severity?: 'degraded' | 'outage' | 'maintenance';
    }
  | {
      enabled: false;
      message?: undefined;
      statusUrl?: undefined;
      affectedServices?: undefined;
      description?: undefined;
      estimatedResolution?: undefined;
      severity?: undefined;
    };

export const maintenanceNoticeFlag = flag({
  key: 'maintenance-notice',
  async decide() {
    try {
      if (!process.env.EDGE_CONFIG) {
        return { enabled: false } as const;
      }

      const flags = await getAll([
        'maintenance-notice_start-time',
        'maintenance-notice_end-time',
        'maintenance-notice_enabled',
      ]);

      if (!flags || Object.keys(flags).length === 0) {
        return { enabled: false } as const;
      }

      const enabled = flags['maintenance-notice_enabled'];

      if (!enabled) {
        return { enabled: false } as const;
      }

      const startTimeRaw = flags['maintenance-notice_start-time'];
      const endTimeRaw = flags['maintenance-notice_end-time'];

      if (!startTimeRaw || !endTimeRaw) {
        return { enabled: false } as const;
      }

      const startTime = new Date(startTimeRaw);
      const endTime = new Date(endTimeRaw);

      if (isNaN(startTime.getTime()) || isNaN(endTime.getTime())) {
        throw new Error(
          `Invalid maintenance notice start or end time: ${startTimeRaw} or ${endTimeRaw}`,
        );
      }

      return {
        enabled: true,
        startTime: startTime.toISOString(),
        endTime: endTime.toISOString(),
      } as const;
    } catch (cause) {
      console.error(
        new Error('Failed to get maintenance notice flag', { cause }),
      );
      return { enabled: false } as const;
    }
  },
});

export const technicalIssueFlag = flag({
  key: 'technical-issue',
  async decide() {
    try {
      if (!process.env.EDGE_CONFIG) {
        return { enabled: false } as const;
      }

      const flags = await getAll([
        'technical-issue_enabled',
        'technical-issue_message',
        'technical-issue_status-url',
        'technical-issue_affected-services',
        'technical-issue_description',
        'technical-issue_estimated-resolution',
        'technical-issue_severity',
      ]);

      if (!flags || Object.keys(flags).length === 0) {
        return { enabled: false } as const;
      }

      const enabled = flags['technical-issue_enabled'];

      if (!enabled) {
        return { enabled: false } as const;
      }

      const message = flags['technical-issue_message'] || 'We are investigating a technical issue';
      const statusUrl = flags['technical-issue_status-url'] || null;
      const affectedServicesRaw = flags['technical-issue_affected-services'];
      const description = flags['technical-issue_description'] || null;
      const estimatedResolution = flags['technical-issue_estimated-resolution'] || null;
      const severity = flags['technical-issue_severity'] || 'degraded';
      
      let affectedServices: string[] | undefined;
      if (affectedServicesRaw) {
        try {
          affectedServices = typeof affectedServicesRaw === 'string' 
            ? JSON.parse(affectedServicesRaw) 
            : affectedServicesRaw;
        } catch {
          affectedServices = undefined;
        }
      }

      return {
        enabled: true,
        message,
        statusUrl,
        affectedServices,
        description,
        estimatedResolution,
        severity: ['degraded', 'outage', 'maintenance'].includes(severity) ? severity : 'degraded',
      } as const;
    } catch (cause) {
      console.error(
        new Error('Failed to get technical issue flag', { cause }),
      );
      return { enabled: false } as const;
    }
  },
});
