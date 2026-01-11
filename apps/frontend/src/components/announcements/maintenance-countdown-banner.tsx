'use client';

import { Wrench, Clock } from 'lucide-react';
import { useEffect, useState } from 'react';
import { AlertBanner } from './alert-banner';

interface MaintenanceCountdownBannerProps {
  startTime: string;
  endTime: string;
  updatedAt?: string;
}

export function MaintenanceCountdownBanner({
  startTime,
  endTime,
  updatedAt,
}: MaintenanceCountdownBannerProps) {
  const [countdown, setCountdown] = useState<string>('');
  const [isActive, setIsActive] = useState(false);
  const [isOver, setIsOver] = useState(false);

  useEffect(() => {
    const updateCountdown = () => {
      try {
        const now = new Date();
        const start = new Date(startTime);
        const end = new Date(endTime);

        if (isNaN(start.getTime()) || isNaN(end.getTime())) {
          setIsOver(true);
          return;
        }

        if (now > end) {
          setIsOver(true);
          return;
        }

        if (now >= start && now <= end) {
          setIsActive(true);
          const diffToEnd = end.getTime() - now.getTime();
          const hours = Math.floor(diffToEnd / (1000 * 60 * 60));
          const minutes = Math.floor((diffToEnd % (1000 * 60 * 60)) / (1000 * 60));

          if (hours > 0) {
            setCountdown(`${hours}h ${minutes}m remaining`);
          } else if (minutes > 0) {
            setCountdown(`${minutes}m remaining`);
          } else {
            setCountdown('Almost done!');
          }
        } else if (now < start) {
          setIsActive(false);
          const diffToStart = start.getTime() - now.getTime();
          const days = Math.floor(diffToStart / (1000 * 60 * 60 * 24));
          const hours = Math.floor((diffToStart % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
          const minutes = Math.floor((diffToStart % (1000 * 60 * 60)) / (1000 * 60));

          if (days > 0) {
            setCountdown(`Starts in ${days}d ${hours}h`);
          } else if (hours > 0) {
            setCountdown(`Starts in ${hours}h ${minutes}m`);
          } else if (minutes > 0) {
            setCountdown(`Starts in ${minutes}m`);
          } else {
            setCountdown('Starting soon');
          }
        }
      } catch {
        setIsOver(true);
      }
    };

    updateCountdown();
    const interval = setInterval(updateCountdown, 30000);
    return () => clearInterval(interval);
  }, [startTime, endTime]);

  if (isOver || isActive) {
    return null;
  }

  const formatDateTime = (isoString: string) => {
    try {
      const date = new Date(isoString);
      if (isNaN(date.getTime())) {
        return isoString;
      }
      return date.toLocaleString(undefined, {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      });
    } catch {
      return isoString;
    }
  };

  return (
    <AlertBanner
      title="Scheduled Maintenance"
      message={`Planned maintenance from ${formatDateTime(startTime)} to ${formatDateTime(endTime)}`}
      variant="warning"
      icon={Wrench}
      dismissKey={`maintenance-${startTime}-${updatedAt || endTime}`}
      countdown={
        <div className="flex items-center gap-1.5 text-xs font-medium text-amber-600 dark:text-amber-400">
          <Clock className="h-3 w-3" />
          <span>{countdown}</span>
        </div>
      }
    />
  );
}
