'use client';

import React from 'react';
import { motion } from 'framer-motion';
import { cn } from '@/lib/utils';
import {
  PenTool,
  Sparkles,
  Layout,
  Palette,
  Globe,
  Mail,
  ShoppingBag,
  Newspaper,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';

// Example use cases for canvas
const useCases = [
  {
    icon: <Layout className="w-5 h-5" />,
    title: 'Build web pages & landing pages',
    description: 'Create stunning HTML/CSS layouts with modern design',
  },
  {
    icon: <Palette className="w-5 h-5" />,
    title: 'Design with AI assistance',
    description: 'Get beautiful color schemes, typography, and layouts',
  },
  {
    icon: <Sparkles className="w-5 h-5" />,
    title: 'Live preview & iteration',
    description: 'See your designs come to life and refine them instantly',
  },
];

// Quick start prompts
const quickPrompts = [
  {
    icon: <Globe className="w-4 h-4" />,
    label: 'Landing page',
    prompt: 'Initialize the tools. Create a modern landing page with a hero section, features grid, testimonials, and a call-to-action. Use a dark theme with gradient accents.',
  },
  {
    icon: <Mail className="w-4 h-4" />,
    label: 'Email template',
    prompt: 'Initialize the tools. Design a professional email newsletter template with a header, featured content section, article previews, and footer with social links.',
  },
  {
    icon: <ShoppingBag className="w-4 h-4" />,
    label: 'Product card',
    prompt: 'Initialize the tools. Create a beautiful product card component with image, title, price, rating, and add-to-cart button. Make it responsive and interactive.',
  },
  {
    icon: <Newspaper className="w-4 h-4" />,
    label: 'Blog layout',
    prompt: 'Initialize the tools. Design a blog article page with a reading-optimized layout, author info, featured image, table of contents, and related posts section.',
  },
];

interface CanvasStarterProps {
  onSelectPrompt: (prompt: string) => void;
  onClose?: () => void;
  className?: string;
}

export function CanvasStarter({
  onSelectPrompt,
  onClose,
  className,
}: CanvasStarterProps) {
  return (
    <div className={cn(
      'relative flex flex-col h-full min-h-0 bg-card/95 dark:bg-card/90 backdrop-blur-sm rounded-2xl overflow-hidden border border-border/50',
      className
    )}>
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-4 border-b border-border/50">
        <div className="flex items-center gap-3">
          <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-violet-500/10">
            <PenTool className="w-4 h-4 text-violet-600 dark:text-violet-400" />
          </div>
          <h2 className="text-base font-semibold text-foreground">AI Canvas</h2>
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
            <div className="flex items-center justify-center w-16 h-16 mx-auto mb-4 rounded-2xl bg-gradient-to-br from-violet-500/20 to-purple-500/20">
              <PenTool className="w-8 h-8 text-violet-600 dark:text-violet-400" />
            </div>
            <h1 className="text-xl font-bold text-foreground mb-2">
              Design Anything with AI
            </h1>
            <p className="text-sm text-muted-foreground max-w-md mx-auto">
              Create beautiful web designs, layouts, and components with natural language.
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
              <div className="flex-shrink-0 w-10 h-10 rounded-lg bg-violet-500/10 flex items-center justify-center text-violet-600 dark:text-violet-400">
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

        {/* Canvas Preview with Overlay */}
        <div className="px-5 py-4 border-t border-border/30">
          <div className="relative rounded-xl border border-border/50 overflow-hidden bg-gradient-to-br from-zinc-900 to-zinc-800 p-4">
            {/* Mock browser chrome */}
            <div className="flex items-center gap-1.5 mb-3">
              <div className="w-2.5 h-2.5 rounded-full bg-red-500/60" />
              <div className="w-2.5 h-2.5 rounded-full bg-yellow-500/60" />
              <div className="w-2.5 h-2.5 rounded-full bg-green-500/60" />
              <div className="flex-1 ml-2 h-5 rounded bg-white/10" />
            </div>
            {/* Mock layout */}
            <div className="space-y-2">
              <div className="h-12 rounded bg-gradient-to-r from-violet-500/20 to-purple-500/20" />
              <div className="grid grid-cols-3 gap-2">
                <div className="h-16 rounded bg-white/5" />
                <div className="h-16 rounded bg-white/5" />
                <div className="h-16 rounded bg-white/5" />
              </div>
              <div className="h-8 w-1/3 mx-auto rounded bg-violet-500/30" />
            </div>
            {/* Overlay */}
            <div className="absolute inset-0 flex items-center justify-center bg-background/60 dark:bg-background/70 backdrop-blur-[2px]">
              <div className="text-center px-4">
                <Layout className="w-6 h-6 mx-auto mb-2 text-violet-500/60" />
                <p className="text-sm font-medium text-muted-foreground">
                  Your design will appear here
                </p>
                <p className="text-xs text-muted-foreground/70 mt-1">
                  Describe what you want to create
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Footer CTA */}
      <div className="px-5 py-4 border-t border-border/50 bg-card/80">
        <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
          <span className="inline-block w-1.5 h-1.5 rounded-full bg-violet-500 animate-pulse" />
          <span>Ready — describe your design in the chat below</span>
        </div>
      </div>
    </div>
  );
}
