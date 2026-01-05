'use client';

import { Clock, AlertTriangle, Server } from 'lucide-react';
import { useEffect, useState } from 'react';

interface MaintenanceNoticeProps {
  endTime: string; // ISO string
}

export function MaintenanceNotice({ endTime }: MaintenanceNoticeProps) {
  const [timeRemaining, setTimeRemaining] = useState<string>('');

  useEffect(() => {
    const updateTimeRemaining = () => {
      const now = new Date();
      const end = new Date(endTime);
      const diff = end.getTime() - now.getTime();

      if (diff <= 0) {
        setTimeRemaining('Almost done!');
        return;
      }

      const hours = Math.floor(diff / (1000 * 60 * 60));
      const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));

      if (hours > 0) {
        setTimeRemaining(`${hours}h ${minutes}m remaining`);
      } else {
        setTimeRemaining(`${minutes}m remaining`);
      }
    };

    updateTimeRemaining();
    const interval = setInterval(updateTimeRemaining, 60000); // Update every minute

    return () => clearInterval(interval);
  }, [endTime]);

  const formatEndTime = (isoString: string) => {
    const date = new Date(isoString);
    return date.toLocaleString(undefined, {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short',
    });
  };

  return (
    <div className="w-full max-w-4xl mx-auto p-4">
      <div className="bg-background border border-border rounded-lg p-6 shadow-sm">
        <div className="flex items-start gap-4">
          <div className="flex-shrink-0">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-amber-100 dark:bg-amber-900/20">
              <Server className="h-6 w-6 text-amber-600 dark:text-amber-500 animate-pulse" />
            </div>
          </div>

          <div className="flex-1 space-y-4">
            <div>
              <h3 className="text-lg font-semibold text-foreground">
                Scheduled Maintenance
              </h3>
              <p className="text-muted-foreground mt-1">
                We're performing scheduled maintenance to improve our systems.
                Some features may be temporarily unavailable.
              </p>
            </div>

            <div className="space-y-3">
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Clock className="h-4 w-4 flex-shrink-0" />
                <span>Expected completion: {formatEndTime(endTime)}</span>
              </div>

              {timeRemaining && (
                <div className="inline-flex items-center gap-2 px-3 py-2 bg-amber-50 dark:bg-amber-900/10 border border-amber-200 dark:border-amber-800/30 rounded-md">
                  <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-500" />
                  <span className="text-sm font-medium text-amber-800 dark:text-amber-200">
                    {timeRemaining}
                  </span>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
