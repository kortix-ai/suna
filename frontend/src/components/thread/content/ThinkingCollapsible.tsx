import React, { useState, useEffect, useRef } from 'react';
import { ChevronRight } from 'lucide-react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';

interface ThinkingCollapsibleProps {
  children?: React.ReactNode;
  isThinking: boolean;
  startTime?: number;
  defaultOpen?: boolean;
}

export const ThinkingCollapsible: React.FC<ThinkingCollapsibleProps> = ({
  children,
  isThinking,
  startTime,
  defaultOpen = true,
}) => {
  const [isOpen, setIsOpen] = useState(defaultOpen);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const stableStartTimeRef = useRef<number | null>(null);

  // Initialize stable start time
  useEffect(() => {
    if (isThinking && !stableStartTimeRef.current) {
      stableStartTimeRef.current = startTime || Date.now();
    }
    if (!isThinking) {
      stableStartTimeRef.current = null;
    }
  }, [isThinking, startTime]);

  // Update elapsed time every second while thinking
  useEffect(() => {
    if (!isThinking) {
      return;
    }

    const updateElapsed = () => {
      if (stableStartTimeRef.current) {
        const elapsed = Math.floor((Date.now() - stableStartTimeRef.current) / 1000);
        setElapsedSeconds(elapsed);
      }
    };

    updateElapsed();
    const interval = setInterval(updateElapsed, 1000);

    return () => clearInterval(interval);
  }, [isThinking]);

  // Format time display
  const formatTime = (seconds: number): string => {
    if (seconds < 60) {
      return `${seconds}s`;
    }
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}m ${secs}s`;
  };

  const hasChildren = React.Children.count(children) > 0;

  if (!isThinking && !hasChildren) {
    return null;
  }

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen}>
      <CollapsibleTrigger asChild>
        <button
          className="flex items-center gap-1.5 py-1.5 group cursor-pointer hover:opacity-80 transition-opacity"
          aria-expanded={isOpen}
        >
          <ChevronRight
            className={cn(
              "h-3.5 w-3.5 text-muted-foreground transition-transform duration-200",
              isOpen && "rotate-90"
            )}
          />
          <span className="text-sm text-muted-foreground">
            Thinking for{' '}
            <span className="font-mono tabular-nums">{formatTime(elapsedSeconds)}</span>
          </span>
          {isThinking && (
            <span className="flex items-center gap-0.5 ml-1">
              <span className="h-1 w-1 rounded-full bg-muted-foreground/60 animate-pulse" />
              <span 
                className="h-1 w-1 rounded-full bg-muted-foreground/60 animate-pulse" 
                style={{ animationDelay: '150ms' }} 
              />
              <span 
                className="h-1 w-1 rounded-full bg-muted-foreground/60 animate-pulse" 
                style={{ animationDelay: '300ms' }} 
              />
            </span>
          )}
        </button>
      </CollapsibleTrigger>
      
      <CollapsibleContent className="overflow-hidden data-[state=open]:animate-collapsible-down data-[state=closed]:animate-collapsible-up">
        <div className="pl-5 pt-1 space-y-2">
          {children}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
};

export default ThinkingCollapsible;

