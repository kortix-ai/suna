'use client';

import React, { useMemo } from 'react';
import { motion } from 'framer-motion';
import { 
  Search, 
  FileText, 
  BookOpen, 
  Palette, 
  Code, 
  Terminal, 
  Image as ImageIcon,
  Building2,
  Sparkles,
  Globe,
  Newspaper,
  Video,
  ShoppingBag,
  MapPin,
  Briefcase,
  GraduationCap,
  Lightbulb,
  Music,
  type LucideIcon
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { KortixLoader } from '@/components/ui/kortix-loader';

interface QueryStyle {
  icon: LucideIcon;
  bgClass: string;
  iconClass: string;
  borderClass: string;
}

// Analyze query content and return appropriate icon + styling
function getQueryStyle(query: string, index: number): QueryStyle {
  const q = query.toLowerCase();
  
  // Documentation & reference
  if (q.includes('documentation') || q.includes('docs') || q.includes('reference') || q.includes('manual')) {
    return {
      icon: FileText,
      bgClass: 'bg-blue-50 dark:bg-blue-950/40',
      iconClass: 'text-blue-600 dark:text-blue-400',
      borderClass: 'border-blue-200 dark:border-blue-800/50',
    };
  }
  
  // Design, colors, UI/UX
  if (q.includes('color') || q.includes('palette') || q.includes('design') || q.includes('style') || q.includes('theme') || q.includes('ui') || q.includes('ux')) {
    return {
      icon: Palette,
      bgClass: 'bg-fuchsia-50 dark:bg-fuchsia-950/40',
      iconClass: 'text-fuchsia-600 dark:text-fuchsia-400',
      borderClass: 'border-fuchsia-200 dark:border-fuchsia-800/50',
    };
  }
  
  // Brand & identity
  if (q.includes('brand') || q.includes('identity') || q.includes('logo') || q.includes('official')) {
    return {
      icon: Building2,
      bgClass: 'bg-amber-50 dark:bg-amber-950/40',
      iconClass: 'text-amber-600 dark:text-amber-400',
      borderClass: 'border-amber-200 dark:border-amber-800/50',
    };
  }
  
  // Code & development
  if (q.includes('code') || q.includes('developer') || q.includes('programming') || q.includes('github') || q.includes('api')) {
    return {
      icon: Code,
      bgClass: 'bg-emerald-50 dark:bg-emerald-950/40',
      iconClass: 'text-emerald-600 dark:text-emerald-400',
      borderClass: 'border-emerald-200 dark:border-emerald-800/50',
    };
  }
  
  // CLI & terminal
  if (q.includes('terminal') || q.includes('cli') || q.includes('command') || q.includes('shell') || q.includes('bash')) {
    return {
      icon: Terminal,
      bgClass: 'bg-slate-100 dark:bg-slate-800/60',
      iconClass: 'text-slate-700 dark:text-slate-300',
      borderClass: 'border-slate-300 dark:border-slate-600/50',
    };
  }
  
  // Learning & tutorials
  if (q.includes('tutorial') || q.includes('learn') || q.includes('course') || q.includes('how to') || q.includes('guide')) {
    return {
      icon: GraduationCap,
      bgClass: 'bg-violet-50 dark:bg-violet-950/40',
      iconClass: 'text-violet-600 dark:text-violet-400',
      borderClass: 'border-violet-200 dark:border-violet-800/50',
    };
  }
  
  // News & articles
  if (q.includes('news') || q.includes('article') || q.includes('blog') || q.includes('latest') || q.includes('update')) {
    return {
      icon: Newspaper,
      bgClass: 'bg-rose-50 dark:bg-rose-950/40',
      iconClass: 'text-rose-600 dark:text-rose-400',
      borderClass: 'border-rose-200 dark:border-rose-800/50',
    };
  }
  
  // Video content
  if (q.includes('video') || q.includes('youtube') || q.includes('watch') || q.includes('stream')) {
    return {
      icon: Video,
      bgClass: 'bg-red-50 dark:bg-red-950/40',
      iconClass: 'text-red-600 dark:text-red-400',
      borderClass: 'border-red-200 dark:border-red-800/50',
    };
  }
  
  // Images & visual
  if (q.includes('image') || q.includes('photo') || q.includes('picture') || q.includes('visual') || q.includes('icon')) {
    return {
      icon: ImageIcon,
      bgClass: 'bg-cyan-50 dark:bg-cyan-950/40',
      iconClass: 'text-cyan-600 dark:text-cyan-400',
      borderClass: 'border-cyan-200 dark:border-cyan-800/50',
    };
  }
  
  // Shopping & products
  if (q.includes('buy') || q.includes('price') || q.includes('product') || q.includes('shop') || q.includes('review')) {
    return {
      icon: ShoppingBag,
      bgClass: 'bg-orange-50 dark:bg-orange-950/40',
      iconClass: 'text-orange-600 dark:text-orange-400',
      borderClass: 'border-orange-200 dark:border-orange-800/50',
    };
  }
  
  // Location & maps
  if (q.includes('location') || q.includes('map') || q.includes('where') || q.includes('near') || q.includes('address')) {
    return {
      icon: MapPin,
      bgClass: 'bg-teal-50 dark:bg-teal-950/40',
      iconClass: 'text-teal-600 dark:text-teal-400',
      borderClass: 'border-teal-200 dark:border-teal-800/50',
    };
  }
  
  // Business & work
  if (q.includes('company') || q.includes('business') || q.includes('corporate') || q.includes('career') || q.includes('job')) {
    return {
      icon: Briefcase,
      bgClass: 'bg-indigo-50 dark:bg-indigo-950/40',
      iconClass: 'text-indigo-600 dark:text-indigo-400',
      borderClass: 'border-indigo-200 dark:border-indigo-800/50',
    };
  }
  
  // Wiki & knowledge
  if (q.includes('wiki') || q.includes('wikipedia') || q.includes('definition') || q.includes('meaning')) {
    return {
      icon: BookOpen,
      bgClass: 'bg-sky-50 dark:bg-sky-950/40',
      iconClass: 'text-sky-600 dark:text-sky-400',
      borderClass: 'border-sky-200 dark:border-sky-800/50',
    };
  }
  
  // AI & innovation
  if (q.includes('ai') || q.includes('machine learning') || q.includes('openai') || q.includes('gpt') || q.includes('llm')) {
    return {
      icon: Sparkles,
      bgClass: 'bg-purple-50 dark:bg-purple-950/40',
      iconClass: 'text-purple-600 dark:text-purple-400',
      borderClass: 'border-purple-200 dark:border-purple-800/50',
    };
  }
  
  // Music & audio
  if (q.includes('music') || q.includes('song') || q.includes('audio') || q.includes('spotify') || q.includes('playlist')) {
    return {
      icon: Music,
      bgClass: 'bg-pink-50 dark:bg-pink-950/40',
      iconClass: 'text-pink-600 dark:text-pink-400',
      borderClass: 'border-pink-200 dark:border-pink-800/50',
    };
  }
  
  // Ideas & concepts
  if (q.includes('idea') || q.includes('inspiration') || q.includes('example') || q.includes('best practice')) {
    return {
      icon: Lightbulb,
      bgClass: 'bg-yellow-50 dark:bg-yellow-950/40',
      iconClass: 'text-yellow-600 dark:text-yellow-400',
      borderClass: 'border-yellow-200 dark:border-yellow-800/50',
    };
  }
  
  // Website searches
  if (q.includes('website') || q.includes('site') || q.includes('.com') || q.includes('.io') || q.includes('homepage')) {
    return {
      icon: Globe,
      bgClass: 'bg-lime-50 dark:bg-lime-950/40',
      iconClass: 'text-lime-600 dark:text-lime-400',
      borderClass: 'border-lime-200 dark:border-lime-800/50',
    };
  }
  
  // Default: cycle through accent colors for variety
  const defaultStyles: QueryStyle[] = [
    {
      icon: Search,
      bgClass: 'bg-zinc-100 dark:bg-zinc-800',
      iconClass: 'text-zinc-500 dark:text-zinc-400',
      borderClass: 'border-zinc-200 dark:border-zinc-700',
    },
    {
      icon: Search,
      bgClass: 'bg-stone-100 dark:bg-stone-800',
      iconClass: 'text-stone-600 dark:text-stone-400',
      borderClass: 'border-stone-200 dark:border-stone-700',
    },
    {
      icon: Search,
      bgClass: 'bg-neutral-100 dark:bg-neutral-800',
      iconClass: 'text-neutral-600 dark:text-neutral-400',
      borderClass: 'border-neutral-200 dark:border-neutral-700',
    },
  ];
  
  return defaultStyles[index % defaultStyles.length];
}

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
  
  // Memoize query styles to prevent recalculation on each render
  const queryStyles = useMemo(() => 
    queries.map((query, index) => getQueryStyle(query, index)), 
    [queries]
  );

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
          <div className="w-16 h-16 rounded-full bg-gradient-to-br from-zinc-100 to-zinc-200 dark:from-zinc-700 dark:to-zinc-800 flex items-center justify-center border border-zinc-200 dark:border-zinc-600 shadow-inner">
            <motion.div
              animate={{ rotate: [0, 10, -10, 0] }}
              transition={{ duration: 2, repeat: Infinity, ease: 'easeInOut' }}
            >
              <Search className="w-7 h-7 text-zinc-600 dark:text-zinc-300" />
            </motion.div>
          </div>
          {/* Pulse ring */}
          <motion.div
            className="absolute inset-0 rounded-full border-2 border-zinc-300 dark:border-zinc-500"
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
          <div className="flex flex-col-reverse gap-2.5">
            {reversedQueries.map((query, index) => {
              // Calculate delay based on original order (newest items animate last)
              const originalIndex = queries.length - 1 - index;
              const delay = originalIndex * 0.08;
              const style = queryStyles[originalIndex];
              const IconComponent = style.icon;

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
                    'bg-white/90 dark:bg-zinc-800/70',
                    'border border-zinc-200/80 dark:border-zinc-700/60',
                    'shadow-sm hover:shadow transition-shadow',
                    'backdrop-blur-sm'
                  )}
                >
                  {/* Query icon with contextual styling */}
                  <div className="flex-shrink-0">
                    <motion.div 
                      className={cn(
                        'w-8 h-8 rounded-lg flex items-center justify-center border',
                        style.bgClass,
                        style.borderClass
                      )}
                      initial={{ rotate: -10, scale: 0.8 }}
                      animate={{ rotate: 0, scale: 1 }}
                      transition={{ delay: delay + 0.1, duration: 0.3, ease: 'easeOut' }}
                    >
                      <IconComponent className={cn('w-4 h-4', style.iconClass)} />
                    </motion.div>
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
