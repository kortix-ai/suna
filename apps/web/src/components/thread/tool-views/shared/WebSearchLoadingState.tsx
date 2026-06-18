'use client';

import React, { useMemo } from 'react';
import { motion } from 'motion/react';
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
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { KortixLoader } from '@/components/ui/kortix-loader';

/**
 * Pick an icon based on query content. We keep the icon meaningful — the rest
 * of the chrome stays monochrome (no per-category background tints) so the
 * tool view feels like the rest of the Kortix surface: hairline borders,
 * mono palette, no chip rainbow.
 */
function getQueryIcon(query: string): LucideIcon {
  const q = query.toLowerCase();
  if (q.includes('documentation') || q.includes('docs') || q.includes('reference') || q.includes('manual')) return FileText;
  if (q.includes('color') || q.includes('palette') || q.includes('design') || q.includes('style') || q.includes('theme') || q.includes('ui') || q.includes('ux')) return Palette;
  if (q.includes('brand') || q.includes('identity') || q.includes('logo') || q.includes('official')) return Building2;
  if (q.includes('code') || q.includes('developer') || q.includes('programming') || q.includes('github') || q.includes('api')) return Code;
  if (q.includes('terminal') || q.includes('cli') || q.includes('command') || q.includes('shell') || q.includes('bash')) return Terminal;
  if (q.includes('tutorial') || q.includes('learn') || q.includes('course') || q.includes('how to') || q.includes('guide')) return GraduationCap;
  if (q.includes('news') || q.includes('article') || q.includes('blog') || q.includes('latest') || q.includes('update')) return Newspaper;
  if (q.includes('video') || q.includes('youtube') || q.includes('watch') || q.includes('stream')) return Video;
  if (q.includes('image') || q.includes('photo') || q.includes('picture') || q.includes('visual') || q.includes('icon')) return ImageIcon;
  if (q.includes('buy') || q.includes('price') || q.includes('product') || q.includes('shop') || q.includes('review')) return ShoppingBag;
  if (q.includes('location') || q.includes('map') || q.includes('where') || q.includes('near') || q.includes('address')) return MapPin;
  if (q.includes('company') || q.includes('business') || q.includes('corporate') || q.includes('career') || q.includes('job')) return Briefcase;
  if (q.includes('wiki') || q.includes('wikipedia') || q.includes('definition') || q.includes('meaning')) return BookOpen;
  if (q.includes('ai') || q.includes('machine learning') || q.includes('openai') || q.includes('gpt') || q.includes('llm')) return Sparkles;
  if (q.includes('music') || q.includes('song') || q.includes('audio') || q.includes('spotify') || q.includes('playlist')) return Music;
  if (q.includes('idea') || q.includes('inspiration') || q.includes('example') || q.includes('best practice')) return Lightbulb;
  if (q.includes('website') || q.includes('site') || q.includes('.com') || q.includes('.io') || q.includes('homepage')) return Globe;
  return Search;
}

interface WebSearchLoadingStateProps {
  queries: string[];
  title?: string;
}

export function WebSearchLoadingState({
  queries,
  title = 'Searching the web',
}: WebSearchLoadingStateProps) {
  const reversedQueries = [...queries].reverse();
  const queryIcons = useMemo(() => queries.map(getQueryIcon), [queries]);

  return (
    <div className="flex flex-col items-center justify-center h-full py-8 px-6 overflow-auto">
      <div className="w-full max-w-md flex flex-col items-center">
        {/* Bare search glyph with a subtle pulse — no chunky filled circle. */}
        <motion.div
          initial={{ scale: 0.9, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
          className="relative mb-5"
        >
          <motion.div
            animate={{ rotate: [0, 8, -8, 0] }}
            transition={{ duration: 2.4, repeat: Infinity, ease: 'easeInOut' }}
          >
            <Search className="w-5 h-5 text-muted-foreground/70" />
          </motion.div>
        </motion.div>

        <motion.h3
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, delay: 0.05, ease: [0.16, 1, 0.3, 1] }}
          className="text-sm font-medium text-foreground tracking-tight mb-5"
        >
          {title}
        </motion.h3>

        <div className="w-full">
          <div className="flex flex-col-reverse gap-1.5">
            {reversedQueries.map((query, index) => {
              const originalIndex = queries.length - 1 - index;
              const delay = originalIndex * 0.06;
              const IconComponent = queryIcons[originalIndex];

              return (
                <motion.div
                  key={`${query}-${index}`}
                  initial={{ opacity: 0, y: 12, scale: 0.98 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  transition={{ duration: 0.35, delay, ease: [0.16, 1, 0.3, 1] }}
                  className={cn(
                    'group flex items-center gap-2.5 px-3 py-2 rounded-2xl',
                    'bg-foreground/[0.02] border border-border/50',
                  )}
                >
                  <IconComponent className="w-3.5 h-3.5 text-muted-foreground/70 flex-shrink-0" />
                  <span className="flex-1 text-sm text-foreground/85 truncate tracking-tight">
                    {query}
                  </span>
                  <KortixLoader customSize={14} />
                </motion.div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
