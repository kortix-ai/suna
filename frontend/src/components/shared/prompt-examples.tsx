'use client';

import React from 'react';
import { motion } from 'framer-motion';
import { ArrowUpRight } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';

export interface PromptExample {
  text: string;
  icon?: React.ComponentType<{ className?: string }>;
}

type Variant = 'text' | 'card';

interface PromptExamplesProps {
  prompts: PromptExample[];
  onPromptClick?: (prompt: string) => void;
  className?: string;
  title?: string;
  showTitle?: boolean;
  columns?: 1 | 2;
  variant?: Variant;
}

export function PromptExamples({
  prompts,
  onPromptClick,
  className,
  title = 'Prompt example',
  showTitle = true,
  columns = 2,
  variant = 'text', // Default to text variant (list style)
}: PromptExamplesProps) {
  if (!prompts || prompts.length === 0) return null;

  // Text variant (list style like RESEARCH mode) - exact match
  if (variant === 'text') {
    return (
      <div className={cn('space-y-2', className)}>
        {showTitle && (
          <p className="text-xs text-muted-foreground/60">
            {title}
          </p>
        )}
        <div className="space-y-1">
          {prompts.map((prompt, index) => (
            <motion.div
              key={`${prompt.text}-${index}`}
              initial={{ opacity: 0, x: -10 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{
                duration: 0.2,
                delay: index * 0.03,
                ease: 'easeOut',
              }}
              className="group cursor-pointer rounded-lg hover:bg-accent/50 transition-colors duration-150"
              onClick={() => onPromptClick?.(prompt.text)}
            >
              <div className="flex items-center justify-between gap-3 px-3 py-2.5">
                <p className="text-sm text-foreground/70 group-hover:text-foreground transition-colors leading-relaxed flex-1">
                  {prompt.text}
                </p>
                <ArrowUpRight className="w-3.5 h-3.5 text-muted-foreground/40 group-hover:text-foreground/60 shrink-0 transition-all duration-150 group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
              </div>
            </motion.div>
          ))}
        </div>
      </div>
    );
  }

  // Card variant (grid style like image/slides modes)
  return (
    <div className={cn('space-y-3', className)}>
      {showTitle && (
        <p className="text-xs text-muted-foreground/60">
          {title}
        </p>
      )}
      <div className={cn(
        'grid gap-3',
        columns === 1 ? 'grid-cols-1' : 'grid-cols-1 md:grid-cols-2'
      )}>
        {prompts.map((prompt, index) => (
          <motion.div
            key={`${prompt.text}-${index}`}
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{
              duration: 0.2,
              delay: index * 0.03,
              ease: 'easeOut',
            }}
          >
            <Card
              className="p-4 cursor-pointer hover:bg-primary/5 transition-all duration-200 group border border-border rounded-xl"
              onClick={() => onPromptClick?.(prompt.text)}
            >
              <div className="flex items-start justify-between gap-2">
                <p className="text-sm text-foreground/80 leading-relaxed flex-1">
                  {prompt.text}
                </p>
                <ArrowUpRight className="w-4 h-4 text-muted-foreground group-hover:text-primary shrink-0 transition-colors duration-200 mt-0.5" />
              </div>
            </Card>
          </motion.div>
        ))}
      </div>
    </div>
  );
}

