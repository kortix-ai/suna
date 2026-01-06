'use client';

import React from 'react';
import { motion } from 'framer-motion';
import { Search } from 'lucide-react';
import { cn } from '@/lib/utils';
import { KortixLoader } from '@/components/ui/kortix-loader';

interface WebSearchLoadingStateProps {
  queries: string[];
  title?: string;
}

export function WebSearchLoadingState({
  queries,
  title = 'Searching the web',
}: WebSearchLoadingStateProps) {
  // Reverse for bottom-to-top visual ordering
  const reversedQueries = [...queries].reverse();

  return (
    <div className="flex flex-col items-center justify-center h-full py-8 px-6 overflow-auto">
      <div className="w-full max-w-md flex flex-col items-center">
        {/* Animated Search Icon */}
        <motion.div
          initial={{ scale: 0.8, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
          className="relative mb-6"
        >
          <div className="w-16 h-16 rounded-full bg-zinc-100 dark:bg-zinc-800 flex items-center justify-center border border-zinc-200 dark:border-zinc-700">
            <motion.div
              animate={{ rotate: [0, 10, -10, 0] }}
              transition={{ duration: 2, repeat: Infinity, ease: 'easeInOut' }}
            >
              <Search className="w-7 h-7 text-zinc-600 dark:text-zinc-400" />
            </motion.div>
          </div>
          {/* Pulse ring */}
          <motion.div
            className="absolute inset-0 rounded-full border-2 border-zinc-300 dark:border-zinc-600"
            animate={{ scale: [1, 1.3, 1.3], opacity: [0.6, 0, 0] }}
            transition={{ duration: 2, repeat: Infinity, ease: 'easeOut' }}
          />
        </motion.div>

        {/* Title */}
        <motion.h3
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, delay: 0.1, ease: [0.16, 1, 0.3, 1] }}
          className="text-lg font-semibold text-zinc-900 dark:text-zinc-100 mb-6"
        >
          {title}
        </motion.h3>

        {/* Query List - Bottom to top with staggered animation */}
        <div className="w-full">
          <div className="flex flex-col-reverse gap-2">
            {reversedQueries.map((query, index) => {
              // Calculate delay based on original order (newest items animate last)
              const originalIndex = queries.length - 1 - index;
              const delay = originalIndex * 0.08;

              return (
                <motion.div
                  key={`${query}-${index}`}
                  initial={{ opacity: 0, y: 20, scale: 0.95 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  transition={{
                    duration: 0.4,
                    delay,
                    ease: [0.16, 1, 0.3, 1],
                  }}
                  className={cn(
                    'group flex items-center gap-3 px-4 py-3 rounded-xl',
                    'bg-white/80 dark:bg-zinc-800/60',
                    'border border-zinc-200/80 dark:border-zinc-700/50',
                    'shadow-sm',
                    'backdrop-blur-sm'
                  )}
                >
                  {/* Query icon */}
                  <div className="flex-shrink-0">
                    <div className="w-8 h-8 rounded-lg bg-zinc-100 dark:bg-zinc-800 flex items-center justify-center border border-zinc-200 dark:border-zinc-700">
                      <Search className="w-4 h-4 text-zinc-500 dark:text-zinc-400" />
                    </div>
                  </div>

                  {/* Query text */}
                  <span className="flex-1 text-sm font-medium text-zinc-700 dark:text-zinc-300 truncate">
                    {query}
                  </span>

                  {/* Kortix loading animation */}
                  <KortixLoader customSize={16} />
                </motion.div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
