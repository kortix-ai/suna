import React, { useState, useEffect } from 'react';
import { AlertCircle } from 'lucide-react-native';
import { AlertBanner } from './AlertBanner';

interface MaintenanceBannerProps {
  startTime: string;
  endTime: string;
  updatedAt?: string;
}

export function MaintenanceBanner({ startTime, endTime, updatedAt }: MaintenanceBannerProps) {
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
            setCountdown('ending soon');
          }
        } else if (now < start) {
          setIsActive(false);
          const diffToStart = start.getTime() - now.getTime();
          const days = Math.floor(diffToStart / (1000 * 60 * 60 * 24));
          const hours = Math.floor((diffToStart % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
          const minutes = Math.floor((diffToStart % (1000 * 60 * 60)) / (1000 * 60));

          if (days > 0) {
            setCountdown(`in ${days}d ${hours}h`);
          } else if (hours > 0) {
            setCountdown(`in ${hours}h ${minutes}m`);
          } else if (minutes > 0) {
            setCountdown(`in ${minutes}m`);
          } else {
            setCountdown('starting soon');
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

  return (
    <AlertBanner
      title="Scheduled maintenance"
      variant="warning"
      icon={AlertCircle}
      dismissKey={`maintenance-${startTime}-${updatedAt || endTime}`}
      countdown={countdown}
    />
  );
}
