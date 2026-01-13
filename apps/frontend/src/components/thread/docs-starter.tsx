'use client';

import React from 'react';
import { motion } from 'framer-motion';
import {
  FileText,
  X,
  FileCode,
  Presentation,
  FileBarChart,
  BookOpen,
  Globe,
  FileCheck,
  Users,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

// Example prompts for docs mode - all prefixed with Initialize the tools
const examplePrompts = [
  {
    label: 'Write a comprehensive PRD for an AI-powered recommendation engine',
    prompt: 'Initialize the tools. Write a comprehensive PRD for an AI-powered recommendation engine.',
  },
  {
    label: 'Draft a technical architecture document for a scalable microservices platform',
    prompt: 'Initialize the tools. Draft a technical architecture document for a scalable microservices platform.',
  },
  {
    label: 'Write an API documentation guide with examples and best practices',
    prompt: 'Initialize the tools. Write an API documentation guide with examples and best practices.',
  },
  {
    label: 'Create a go-to-market strategy document for our Q2 product launch',
    prompt: 'Initialize the tools. Create a go-to-market strategy document for our Q2 product launch.',
  },
];

// Document templates
const templates = [
  {
    id: 'prd',
    icon: FileText,
    label: 'PRD',
    description: 'Product requirements document',
    prompt: 'Initialize the tools. Create a comprehensive Product Requirements Document (PRD) with sections for overview, goals, user stories, requirements, success metrics, and timeline.',
  },
  {
    id: 'technical',
    icon: FileCode,
    label: 'Technical',
    description: 'Technical documentation',
    prompt: 'Initialize the tools. Create a technical documentation with sections for architecture overview, system components, API endpoints, data models, and deployment guide.',
  },
  {
    id: 'proposal',
    icon: Presentation,
    label: 'Proposal',
    description: 'Business proposal',
    prompt: 'Initialize the tools. Create a business proposal document with executive summary, problem statement, proposed solution, implementation plan, budget, and expected outcomes.',
  },
  {
    id: 'report',
    icon: FileBarChart,
    label: 'Report',
    description: 'Detailed report format',
    prompt: 'Initialize the tools. Create a detailed report with executive summary, methodology, findings, analysis, recommendations, and appendix sections.',
  },
  {
    id: 'guide',
    icon: BookOpen,
    label: 'Guide',
    description: 'Step-by-step guide',
    prompt: 'Initialize the tools. Create a comprehensive step-by-step guide with introduction, prerequisites, detailed instructions, troubleshooting tips, and FAQs.',
  },
  {
    id: 'wiki',
    icon: Globe,
    label: 'Wiki',
    description: 'Knowledge base article',
    prompt: 'Initialize the tools. Create a knowledge base wiki article with overview, key concepts, detailed explanations, examples, related topics, and references.',
  },
  {
    id: 'policy',
    icon: FileCheck,
    label: 'Policy',
    description: 'Policy document',
    prompt: 'Initialize the tools. Create a policy document with purpose, scope, policy statements, procedures, responsibilities, compliance requirements, and review schedule.',
  },
  {
    id: 'meeting-notes',
    icon: Users,
    label: 'Meeting Notes',
    description: 'Meeting minutes',
    prompt: 'Initialize the tools. Create meeting notes with date, attendees, agenda items, discussion points, decisions made, action items with owners, and next steps.',
  },
];

interface DocsStarterProps {
  onSelectPrompt: (prompt: string, placeholderInfo?: { start: number; end: number }) => void;
  onClose?: () => void;
  className?: string;
  sandboxId?: string | null;
  project?: {
    sandbox?: {
      id?: string;
    };
  };
}

export function DocsStarter({
  onSelectPrompt,
  onClose,
  className,
}: DocsStarterProps) {
  return (
    <div className={cn(
      'relative flex flex-col h-full min-h-0 bg-card/95 dark:bg-card/90 backdrop-blur-sm rounded-2xl overflow-hidden border border-border/50',
      className
    )}>
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-4 border-b border-border/50 flex-shrink-0">
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
        {/* Example Prompts */}
        <div className="p-5 space-y-2">
          {examplePrompts.map((item, index) => (
            <motion.button
              key={index}
              initial={{ opacity: 0, y: 5 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: index * 0.05, duration: 0.2 }}
              onClick={() => {
                console.log('[DocsStarter] Prompt clicked:', item.prompt);
                onSelectPrompt(item.prompt);
              }}
              className={cn(
                'w-full text-left px-4 py-3 rounded-xl',
                'bg-muted/30 hover:bg-muted/50 border border-transparent hover:border-border/50',
                'transition-all duration-150 cursor-pointer',
                'text-sm text-muted-foreground hover:text-foreground',
              )}
            >
              <span className="line-clamp-2">{item.label}</span>
            </motion.button>
          ))}
        </div>

        {/* Templates Section */}
        <div className="px-5 pb-5">
          <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-3">
            Choose a template
          </h3>
          <div className="grid grid-cols-4 gap-2">
            {templates.map((template, index) => {
              const Icon = template.icon;
              return (
                <motion.button
                  key={template.id}
                  initial={{ opacity: 0, scale: 0.95 }}
                  animate={{ opacity: 1, scale: 1 }}
                  transition={{ delay: 0.2 + index * 0.03, duration: 0.15 }}
                  onClick={() => {
                    console.log('[DocsStarter] Template clicked:', template.prompt);
                    onSelectPrompt(template.prompt);
                  }}
                  className={cn(
                    'flex flex-col items-center gap-1.5 p-3 rounded-xl text-center',
                    'bg-muted/30 hover:bg-muted/50 border border-transparent hover:border-border/50',
                    'transition-all duration-150 cursor-pointer',
                    'group'
                  )}
                >
                  <div className="flex items-center justify-center w-9 h-9 rounded-lg bg-blue-500/10 group-hover:bg-blue-500/15 transition-colors">
                    <Icon className="w-4 h-4 text-blue-600 dark:text-blue-400" />
                  </div>
                  <div className="space-y-0.5">
                    <p className="text-xs font-medium text-foreground leading-tight">{template.label}</p>
                    <p className="text-[10px] text-muted-foreground leading-tight line-clamp-1">{template.description}</p>
                  </div>
                </motion.button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
