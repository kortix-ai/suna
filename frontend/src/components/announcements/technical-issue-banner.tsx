'use client';

import { AlertTriangle, ExternalLink, X } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { useEffect, useState } from 'react';

interface TechnicalIssueBannerProps {
  message: string;
  statusUrl?: string;
}

export function TechnicalIssueBanner({
  message,
  statusUrl,
}: TechnicalIssueBannerProps) {
  const [isDismissed, setIsDismissed] = useState(false);
  const [isMounted, setIsMounted] = useState(false);

  const dismissKey = `technical-issue-dismissed-${message}`;

  useEffect(() => {
    setIsMounted(true);
    const dismissed = localStorage.getItem(dismissKey);
    if (dismissed === 'true') {
      setIsDismissed(true);
    }
  }, [dismissKey]);

  const handleDismiss = () => {
    setIsDismissed(true);
    localStorage.setItem(dismissKey, 'true');
  };

  const handleStatusClick = () => {
    if (statusUrl) {
      window.open(statusUrl, '_blank', 'noopener,noreferrer');
    }
  };

  if (!isMounted || isDismissed) {
    return null;
  }

  return (
    <Alert className="hover:bg-destructive/10 transition-colors duration-300 border-destructive/10 py-1 border-x-0 border-t-0 bg-destructive/5 rounded-none" onClick={handleStatusClick}>
      <AlertDescription className="flex items-center justify-between gap-3 text-destructive">
        <div className="flex items-center w-full justify-center gap-3">
          <span className="font-medium">{message}</span>
          {statusUrl && (
            <Button
              variant="link"
              size="sm"
              className="text-destructive text-xs mt-0.5"
              onClick={handleStatusClick}
            >
              See More
              <ExternalLink className="size-3" />
            </Button>
          )}
        </div>
        
        {/* <Button
          variant="ghost"
          size="sm"
          className="h-6 w-6 p-0 text-red-600 hover:text-red-800 dark:text-red-400 dark:hover:text-red-200 hover:bg-transparent flex-shrink-0"
          onClick={handleDismiss}
          aria-label="Dismiss technical issue notice"
        >
          <X className="h-3 w-3" />
        </Button> */}
      </AlertDescription>
    </Alert>
  );
}
