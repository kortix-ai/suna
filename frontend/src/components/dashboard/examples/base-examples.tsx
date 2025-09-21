'use client';

import React from 'react';
import { motion } from 'framer-motion';
import { Button } from '@/components/ui/button';
import { RefreshCw } from 'lucide-react';

export type ExamplePrompt = {
  title: string;
  query: string;
  icon: React.ReactNode;
};

export interface BaseExamplesProps {
  examples: ExamplePrompt[];
  onSelectPrompt?: (query: string) => void;
  count?: number;
  title?: string;
  description?: string;
}

export function BaseExamples({ 
  examples,
  onSelectPrompt,
  count = 4,
  title,
  description
}: BaseExamplesProps) {
  const [displayedPrompts, setDisplayedPrompts] = React.useState<ExamplePrompt[]>([]);
  const [isRefreshing, setIsRefreshing] = React.useState(false);

  const getRandomPrompts = React.useCallback((prompts: ExamplePrompt[], num: number) => {
    const shuffled = [...prompts].sort(() => 0.5 - Math.random());
    return shuffled.slice(0, num);
  }, []);

  React.useEffect(() => {
    setDisplayedPrompts(getRandomPrompts(examples, count));
  }, [examples, count, getRandomPrompts]);

  const handleRefresh = () => {
    setIsRefreshing(true);
    setDisplayedPrompts(getRandomPrompts(examples, count));
    setTimeout(() => setIsRefreshing(false), 300);
  };

  return (
    <div className="w-full max-w-4xl mx-auto">
      {(title || description) && (
        <div className="text-center mb-3">
          {title && (
            <h3 className="text-xs font-medium text-muted-foreground/80 uppercase tracking-wider mb-1">
              {title}
            </h3>
          )}
          {description && (
            <p className="text-xs text-muted-foreground/60">
              {description}
            </p>
          )}
        </div>
      )}
      
      <div className="group relative">
        <div className="flex gap-2 justify-center py-2 flex-wrap">
          {displayedPrompts.map((prompt, index) => (
            <motion.div
              key={`${prompt.title}-${index}`}
              initial={{ opacity: 0, scale: 0.8 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{
                duration: 0.3,
                delay: index * 0.03,
                ease: "easeOut"
              }}
            >
              <Button
                variant="outline"
                className="w-fit h-fit px-3 py-2 rounded-full border-neutral-200 dark:border-neutral-800 bg-neutral-50 hover:bg-neutral-100 dark:bg-neutral-900 dark:hover:bg-neutral-800 text-sm font-normal text-muted-foreground hover:text-foreground transition-colors"
                onClick={() => onSelectPrompt?.(prompt.query)}
              >
                <div className="flex items-center gap-2">
                  <div className="flex-shrink-0">
                    {React.cloneElement(prompt.icon as React.ReactElement, { size: 14 })}
                  </div>
                  <span className="whitespace-nowrap">{prompt.title}</span>
                </div>
              </Button>
            </motion.div>
          ))}
        </div>

        {examples.length > count && (
          <Button
            variant="ghost"
            size="sm"
            onClick={handleRefresh}
            className={`
              absolute -right-2 top-1/2 -translate-y-1/2 
              opacity-0 group-hover:opacity-100
              transition-all duration-200 ease-in-out
              h-7 w-7 p-0 rounded-full
              hover:bg-neutral-100 dark:hover:bg-neutral-800
              ${isRefreshing ? 'animate-spin' : ''}
            `}
            aria-label="Refresh examples"
          >
            <RefreshCw className="h-3.5 w-3.5 text-muted-foreground" />
          </Button>
        )}
      </div>
    </div>
  );
}
