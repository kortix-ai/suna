'use client';

import React from 'react';
import { motion } from 'framer-motion';
import { cn } from '@/lib/utils';
import {
  FileText,
  PenLine,
  Sparkles,
  BookOpen,
  FileEdit,
  ScrollText,
  Briefcase,
  GraduationCap,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';

// Example use cases for docs
const useCases = [
  {
    icon: <PenLine className="w-5 h-5" />,
    title: 'Write anything from scratch',
    description: 'Blog posts, articles, reports, essays, and more',
  },
  {
    icon: <Sparkles className="w-5 h-5" />,
    title: 'AI-powered writing assistance',
    description: 'Auto-complete, rewrite, expand, or summarize content',
  },
  {
    icon: <BookOpen className="w-5 h-5" />,
    title: 'Professional document formatting',
    description: 'Structured layouts with headers, lists, and sections',
  },
];

// Quick start prompts
const quickPrompts = [
  {
    icon: <Briefcase className="w-4 h-4" />,
    label: 'Business proposal',
    prompt: 'Initialize the tools. Create a professional business proposal document with executive summary, problem statement, proposed solution, timeline, and pricing sections.',
  },
  {
    icon: <FileEdit className="w-4 h-4" />,
    label: 'Blog post',
    prompt: 'Initialize the tools. Write a blog post about [topic]. Include an engaging introduction, main points with examples, and a compelling conclusion with a call to action.',
  },
  {
    icon: <GraduationCap className="w-4 h-4" />,
    label: 'Research paper',
    prompt: 'Initialize the tools. Create a research paper outline on [topic] with abstract, introduction, literature review, methodology, results, discussion, and conclusion sections.',
  },
  {
    icon: <ScrollText className="w-4 h-4" />,
    label: 'Meeting notes',
    prompt: 'Initialize the tools. Create a meeting notes template with date, attendees, agenda items, discussion points, action items, and next steps sections.',
  },
];

interface DocsStarterProps {
  onSelectPrompt: (prompt: string, placeholderInfo?: { start: number; end: number }) => void;
  onClose?: () => void;
  className?: string;
  sandboxId?: string | null;
  project?: any;
}

export function DocsStarter({
  onSelectPrompt,
  onClose,
  className,
  sandboxId,
  project,
}: DocsStarterProps) {
  return (
    <div className={cn(
      'relative flex flex-col h-full min-h-0 bg-card/95 dark:bg-card/90 backdrop-blur-sm rounded-2xl overflow-hidden border border-border/50',
      className
    )}>
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-4 border-b border-border/50">
        <div className="flex items-center gap-3">
          <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-blue-500/10">
            <FileText className="w-4 h-4 text-blue-600 dark:text-blue-400" />
          </div>
          <h2 className="text-base font-semibold text-foreground">AI Docs</h2>
        </div>
        {onClose && (
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 text-muted-foreground hover:text-foreground"
            onClick={onClose}
          >
            <X className="h-4 w-4" />
          </Button>
        )}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        {/* Hero Section */}
        <div className="px-6 py-8 text-center border-b border-border/30">
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3 }}
          >
            <div className="flex items-center justify-center w-16 h-16 mx-auto mb-4 rounded-2xl bg-gradient-to-br from-blue-500/20 to-indigo-500/20">
              <FileText className="w-8 h-8 text-blue-600 dark:text-blue-400" />
            </div>
            <h1 className="text-xl font-bold text-foreground mb-2">
              Create Beautiful Documents
            </h1>
            <p className="text-sm text-muted-foreground max-w-md mx-auto">
              Let AI help you write, format, and polish professional documents in seconds.
            </p>
          </motion.div>
        </div>

        {/* Use Cases */}
        <div className="px-5 py-5 space-y-3">
          {useCases.map((useCase, index) => (
            <motion.div
              key={index}
              initial={{ opacity: 0, x: -10 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: index * 0.1, duration: 0.2 }}
              className="flex items-start gap-3 p-3 rounded-xl bg-muted/30 border border-border/30"
            >
              <div className="flex-shrink-0 w-10 h-10 rounded-lg bg-blue-500/10 flex items-center justify-center text-blue-600 dark:text-blue-400">
                {useCase.icon}
              </div>
              <div>
                <p className="text-sm font-medium text-foreground">{useCase.title}</p>
                <p className="text-xs text-muted-foreground mt-0.5">{useCase.description}</p>
              </div>
            </motion.div>
          ))}
        </div>

        {/* Quick Start Prompts */}
        <div className="px-5 py-4 border-t border-border/30">
          <h3 className="text-sm font-medium text-muted-foreground mb-3">
            Quick start
          </h3>
          <div className="grid grid-cols-2 gap-2">
            {quickPrompts.map((item, index) => (
              <motion.button
                key={index}
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ delay: 0.3 + index * 0.05, duration: 0.15 }}
                onClick={() => onSelectPrompt(item.prompt)}
                className={cn(
                  'flex items-center gap-2 p-3 rounded-xl text-left',
                  'bg-muted/40 hover:bg-accent border border-border/50 hover:border-foreground/20',
                  'transition-all duration-150 cursor-pointer',
                  'group'
                )}
              >
                <div className="flex-shrink-0 text-muted-foreground group-hover:text-foreground transition-colors">
                  {item.icon}
                </div>
                <span className="text-xs font-medium text-muted-foreground group-hover:text-foreground transition-colors line-clamp-2">
                  {item.label}
                </span>
              </motion.button>
            ))}
          </div>
        </div>

        {/* Document Preview with Overlay */}
        <div className="px-5 py-4 border-t border-border/30">
          <div className="relative rounded-xl border border-border/50 overflow-hidden bg-white dark:bg-zinc-900 p-4">
            {/* Document lines */}
            <div className="space-y-3">
              <div className="h-4 w-3/4 rounded bg-muted/40" />
              <div className="h-3 w-full rounded bg-muted/30" />
              <div className="h-3 w-5/6 rounded bg-muted/30" />
              <div className="h-3 w-full rounded bg-muted/30" />
              <div className="h-4 w-1/2 rounded bg-muted/40 mt-4" />
              <div className="h-3 w-full rounded bg-muted/30" />
              <div className="h-3 w-4/5 rounded bg-muted/30" />
            </div>
            {/* Overlay */}
            <div className="absolute inset-0 flex items-center justify-center bg-background/70 dark:bg-background/80 backdrop-blur-[2px]">
              <div className="text-center px-4">
                <PenLine className="w-6 h-6 mx-auto mb-2 text-blue-500/60" />
                <p className="text-sm font-medium text-muted-foreground">
                  Your document will appear here
                </p>
                <p className="text-xs text-muted-foreground/70 mt-1">
                  Describe what you want to write
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Footer CTA */}
      <div className="px-5 py-4 border-t border-border/50 bg-card/80">
        <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
          <span className="inline-block w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse" />
          <span>Ready — describe your document in the chat below</span>
        </div>
      </div>
    </div>
  );
}
