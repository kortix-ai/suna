'use client';

import React from 'react';
import { motion } from 'framer-motion';
import { ArrowUpRight } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import Image from 'next/image';

export interface PromptExample {
  text: string;
  icon?: React.ComponentType<{ className?: string }>;
  thumbnail?: string;
}

type Variant = 'text' | 'card' | 'visual';

interface PromptExamplesProps {
  prompts: PromptExample[];
  onPromptClick?: (prompt: string) => void;
  className?: string;
  title?: string;
  showTitle?: boolean;
  columns?: 1 | 2 | 3 | 4;
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

  // Text variant (list style with card containers like sidebar items)
  if (variant === 'text') {
    return (
      <div className={cn('space-y-2', className)}>
        {showTitle && (
          <p className="text-xs text-muted-foreground/60">
            {title}
          </p>
        )}
        <div className="space-y-2">
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
              className="group cursor-pointer rounded-xl border border-border hover:bg-muted transition-colors duration-150"
              onClick={() => onPromptClick?.(prompt.text)}
            >
              <div className="flex items-center gap-3 p-3">
                <p className="text-sm text-foreground/80 group-hover:text-foreground transition-colors leading-relaxed flex-1">
                  {prompt.text}
                </p>
                <ArrowUpRight className="w-4 h-4 text-muted-foreground/40 group-hover:text-foreground/60 shrink-0 transition-all duration-150 group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
              </div>
            </motion.div>
          ))}
        </div>
      </div>
    );
  }

  // Visual variant (grid with thumbnails for visual modes like slides, image, video)
  if (variant === 'visual') {
    return (
      <div className={cn('space-y-3', className)}>
        {showTitle && (
          <p className="text-xs text-muted-foreground/60">
            {title}
          </p>
        )}
        <div className={cn(
          'grid gap-3',
          columns === 1 ? 'grid-cols-1' : 
          columns === 3 ? 'grid-cols-2 sm:grid-cols-3' :
          columns === 4 ? 'grid-cols-2 sm:grid-cols-3 md:grid-cols-4' :
          'grid-cols-1 sm:grid-cols-2'
        )}>
          {prompts.map((prompt, index) => (
            <motion.div
              key={`${prompt.text}-${index}`}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{
                duration: 0.25,
                delay: index * 0.04,
                ease: 'easeOut',
              }}
            >
              <Card
                className="flex flex-col gap-2 cursor-pointer p-2 hover:bg-accent/30 transition-all duration-200 group border border-border hover:border-border/80 rounded-xl"
                onClick={() => onPromptClick?.(prompt.text)}
              >
                {/* Thumbnail - matches template thumbnail styling */}
                <div className="relative w-full aspect-video bg-muted/30 overflow-hidden rounded-lg border border-border/50 group-hover:border-primary/30 group-hover:scale-[1.02] transition-all duration-200">
                  {prompt.thumbnail ? (
                    <Image
                      src={prompt.thumbnail}
                      alt={prompt.text}
                      fill
                      sizes="(max-width: 640px) 50vw, (max-width: 768px) 33vw, 25vw"
                      className="object-contain"
                      loading="lazy"
                    />
                  ) : (
                    // Gradient placeholder with pattern
                    <div className="absolute inset-0 bg-gradient-to-br from-primary/5 via-primary/10 to-primary/5">
                      <div className="absolute inset-0 opacity-30" style={{
                        backgroundImage: `url("data:image/svg+xml,%3Csvg width='20' height='20' viewBox='0 0 20 20' xmlns='http://www.w3.org/2000/svg'%3E%3Cg fill='%239C92AC' fill-opacity='0.1' fill-rule='evenodd'%3E%3Ccircle cx='3' cy='3' r='3'/%3E%3Ccircle cx='13' cy='13' r='3'/%3E%3C/g%3E%3C/svg%3E")`,
                      }} />
                    </div>
                  )}
                </div>
                {/* Text */}
                <p className="text-xs text-foreground/70 group-hover:text-foreground leading-relaxed line-clamp-2 transition-colors duration-200 px-0.5">
                  {prompt.text}
                </p>
              </Card>
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

