import React, { useState, useEffect, useRef } from 'react';
import { ChevronRight } from 'lucide-react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';

// Circular progress bar that estimates completion
const CircularProgressBar: React.FC<{ 
  elapsedSeconds: number; 
  size?: number; 
  className?: string;
}> = ({ 
  elapsedSeconds,
  size = 18, 
  className 
}) => {
  // Estimate progress using asymptotic curve
  // Assumes most tasks complete within 30-60 seconds
  // Progress approaches 95% asymptotically, leaving room for actual completion
  const expectedDuration = 45; // seconds for "average" task
  const progress = Math.min(0.95, 1 - Math.exp(-elapsedSeconds / expectedDuration));
  
  const strokeWidth = 2.5;
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const strokeDashoffset = circumference * (1 - progress);
  
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      className={cn("shrink-0", className)}
      style={{ transform: 'rotate(-90deg)' }}
    >
      {/* Background circle track */}
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        className="opacity-25"
      />
      {/* Progress arc that fills up */}
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={strokeDashoffset}
        className="transition-all duration-1000 ease-out"
      />
    </svg>
  );
};

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
  defaultOpen = false,
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
          className="flex items-center gap-2 py-1.5 group cursor-pointer hover:opacity-80 transition-opacity"
          aria-expanded={isOpen}
        >
          <ChevronRight
            className={cn(
              "h-3.5 w-3.5 text-muted-foreground transition-transform duration-200",
              isOpen && "rotate-90"
            )}
          />
          {isThinking && (
            <CircularProgressBar 
              elapsedSeconds={elapsedSeconds} 
              size={18} 
              className="text-muted-foreground" 
            />
          )}
          <span className="text-sm text-muted-foreground">
            Thinking for{' '}
            <span className="font-mono tabular-nums">{formatTime(elapsedSeconds)}</span>
          </span>
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

