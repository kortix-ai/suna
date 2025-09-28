'use client';

import React, { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Loader2, AlertCircle, RefreshCw } from 'lucide-react';
import { useVncPreloader } from '@/hooks/useVncPreloader';

interface HealthCheckedVncIframeProps {
  sandbox: {
    id: string;
    vnc_preview: string;
    pass: string;
  };
  className?: string;
}

export function HealthCheckedVncIframe({ sandbox, className }: HealthCheckedVncIframeProps) {
  const [iframeKey, setIframeKey] = useState(0);
  
  // Use the enhanced VNC preloader hook
  const { status, retryCount, retry, isPreloaded } = useVncPreloader(sandbox, {
    maxRetries: 5,
    initialDelay: 1000,
    timeoutMs: 5000
  });




  // VNC URL received but preloading in progress
  if (status === 'loading') {
    return (
      <div className={`overflow-hidden m-2 sm:m-4 relative ${className || ''}`}>
        <Card className="p-0 overflow-hidden border">
          <div className='relative w-full aspect-[4/3] sm:aspect-[5/3] md:aspect-[16/11] overflow-hidden bg-amber-50 dark:bg-amber-950/30 flex flex-col items-center justify-center'>
            <Loader2 className="h-8 w-8 animate-spin text-amber-600 mb-3" />
            <p className="text-sm font-medium text-center mb-2">Connecting to browser...</p>
            <p className="text-xs text-muted-foreground mb-2 text-center">
              Testing VNC connection
            </p>
            {retryCount > 0 && (
              <p className="text-xs text-amber-600 text-center">
                🔄 Attempt {retryCount + 1}/5
              </p>
            )}
          </div>
        </Card>
      </div>
    );
  }

  // VNC preload failed after retries
  if (status === 'error') {
    return (
      <div className={`overflow-hidden m-2 sm:m-4 relative ${className || ''}`}>
        <Card className="p-0 overflow-hidden border">
          <div className='relative w-full aspect-[4/3] sm:aspect-[5/3] md:aspect-[16/11] overflow-hidden bg-destructive/10 flex flex-col items-center justify-center'>
            <AlertCircle className="h-8 w-8 text-destructive mb-3" />
            <p className="text-sm font-medium text-center mb-2">Connection Failed</p>
            <p className="text-xs text-muted-foreground mb-4 text-center">
              Unable to connect to VNC server after 5 attempts
            </p>
            <Button
              variant="outline"
              size="sm"
              onClick={retry}
            >
              <RefreshCw className="h-4 w-4 mr-1" />
              Try Again
            </Button>
          </div>
        </Card>
      </div>
    );
  }

  if (isPreloaded) {
    return (
      <div className={`overflow-hidden m-2 sm:m-4 relative ${className || ''}`}>
        <Card className="p-0 overflow-hidden border">
          <div className='relative w-full aspect-[4/3] sm:aspect-[5/3] md:aspect-[16/11] overflow-hidden bg-gray-100 dark:bg-gray-800'>
            <iframe
              key={iframeKey}
              src={`${sandbox.vnc_preview}/vnc_lite.html?password=${sandbox.pass}&autoconnect=true&scale=local`}
              title="Browser preview"
              className="absolute inset-0 w-full h-full border-0 md:w-[102%] md:h-[130%] md:-translate-y-[4.4rem] lg:-translate-y-[4.7rem] xl:-translate-y-[5.4rem] md:left-0 md:-translate-x-2"
            />
          </div>
        </Card>
      </div>
    );
  }

  // Should not reach here
  return null;
}
