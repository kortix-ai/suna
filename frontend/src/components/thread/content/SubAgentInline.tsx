/**
 * SubAgentInline - Inline display for spawn_sub_agent tool calls
 * Always shows the window, title = task, open button to view thread
 */

import React, { useState, useEffect, useRef, useMemo } from 'react';
import { CircleDashed, GitBranch, ExternalLink, CheckCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { UnifiedMarkdown } from '@/components/markdown';
import Link from 'next/link';
import { Project } from '@/lib/api/threads';

interface SubAgentInlineProps {
  toolCall: {
    function_name: string;
    arguments?: Record<string, any>;
    tool_call_id?: string;
    rawArguments?: string;
  };
  toolResult?: {
    success?: boolean;
    output?: any;
    error?: string | null;
  };
  isStreaming?: boolean;
  streamingText?: string;
  project?: Project;
  onToolClick?: () => void;
}

function parseStreamingArgs(rawArgs: string | undefined): { task?: string; context?: string } {
  if (!rawArgs) return {};
  try {
    const parsed = JSON.parse(rawArgs);
    return { task: parsed.task, context: parsed.context };
  } catch {
    const taskMatch = rawArgs.match(/"task"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    const partialTaskMatch = rawArgs.match(/"task"\s*:\s*"([^"]*)/);
    const contextMatch = rawArgs.match(/"context"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    const partialContextMatch = rawArgs.match(/"context"\s*:\s*"([^"]*)/);
    return {
      task: (taskMatch?.[1] || partialTaskMatch?.[1])?.replace(/\\n/g, '\n').replace(/\\"/g, '"'),
      context: (contextMatch?.[1] || partialContextMatch?.[1])?.replace(/\\n/g, '\n').replace(/\\"/g, '"'),
    };
  }
}

function parseResultOutput(output: any): { sub_agent_id?: string; thread_id?: string; task?: string } {
  if (!output) return {};
  if (typeof output === 'string') {
    try { return JSON.parse(output); } catch { return {}; }
  }
  return output;
}

export const SubAgentInline: React.FC<SubAgentInlineProps> = ({
  toolCall,
  toolResult,
  isStreaming = false,
  streamingText,
  project,
  onToolClick
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  
  // Parse result
  const resultData = useMemo(() => {
    if (toolResult?.output) return parseResultOutput(toolResult.output);
    return {};
  }, [toolResult]);
  
  const isCompleted = !!toolResult && !!resultData.sub_agent_id;
  const isExecuting = !isCompleted;
  
  // Streaming content
  const rawStreamingSource = toolCall.rawArguments || streamingText;
  const [throttledSource, setThrottledSource] = useState(rawStreamingSource);
  const throttleRef = useRef<NodeJS.Timeout | null>(null);
  const lastUpdateRef = useRef<number>(0);
  
  useEffect(() => {
    if (isCompleted) return;
    
    const now = Date.now();
    const THROTTLE_MS = 100;
    
    if (now - lastUpdateRef.current >= THROTTLE_MS) {
      setThrottledSource(rawStreamingSource);
      lastUpdateRef.current = now;
    } else {
      if (throttleRef.current) clearTimeout(throttleRef.current);
      throttleRef.current = setTimeout(() => {
        setThrottledSource(rawStreamingSource);
        lastUpdateRef.current = Date.now();
      }, THROTTLE_MS);
    }
    
    return () => { if (throttleRef.current) clearTimeout(throttleRef.current); };
  }, [rawStreamingSource, isCompleted]);
  
  // Parse streaming args
  const streamingArgs = useMemo(() => {
    if (isExecuting && throttledSource) {
      return parseStreamingArgs(throttledSource);
    }
    return {};
  }, [isExecuting, throttledSource]);
  
  // Display values
  const displayTask = streamingArgs.task || toolCall.arguments?.task || resultData.task || '';
  const displayContext = streamingArgs.context || toolCall.arguments?.context || '';
  
  // Title = first 50 chars of task
  const headerTitle = displayTask 
    ? (displayTask.length > 50 ? displayTask.slice(0, 50) + '...' : displayTask)
    : 'Sub-Agent Task';
  
  // Link to sub-agent thread
  const linkHref = project?.project_id && resultData.thread_id 
    ? `/projects/${project.project_id}?threadId=${resultData.thread_id}` 
    : null;

  // Content to display
  const contentToDisplay = useMemo(() => {
    let content = displayTask;
    if (displayContext) {
      content += '\n\n---\n**Context:**\n' + displayContext;
    }
    return content;
  }, [displayTask, displayContext]);

  return (
    <div className="my-1.5">
      <div className="border border-neutral-200 dark:border-neutral-700/50 rounded-2xl overflow-hidden bg-zinc-100 dark:bg-neutral-900">
        {/* Header with task title */}
        <div className="flex items-center gap-1.5 py-1.5 px-2 bg-muted">
          <div className="flex items-center justify-center p-1 rounded-sm">
            <GitBranch className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
          </div>
          <span className="font-mono text-xs text-foreground flex-1 truncate" title={displayTask}>
            {headerTitle}
          </span>
          
          {/* Status indicator */}
          {isExecuting ? (
            <CircleDashed className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0 animate-spin" />
          ) : (
            <CheckCircle className="h-3.5 w-3.5 text-green-500 flex-shrink-0" />
          )}
          
          {/* Open button */}
          {linkHref && (
            <Link 
              href={linkHref}
              className="flex items-center gap-1 px-2 py-0.5 text-[10px] font-medium text-muted-foreground hover:text-foreground bg-zinc-200 dark:bg-zinc-800 hover:bg-zinc-300 dark:hover:bg-zinc-700 rounded transition-colors"
            >
              Open
              <ExternalLink className="h-2.5 w-2.5" />
            </Link>
          )}
        </div>

        {/* Content */}
        <div className="border-t border-neutral-200 dark:border-neutral-700/50">
          <div className="relative">
            <div
              ref={containerRef}
              className="max-h-[300px] overflow-y-auto scrollbar-none text-xs text-foreground p-3"
              style={isExecuting ? {
                maskImage: 'linear-gradient(to bottom, transparent 0%, black 8%, black 92%, transparent 100%)',
                WebkitMaskImage: 'linear-gradient(to bottom, transparent 0%, black 8%, black 92%, transparent 100%)'
              } : undefined}
            >
              {contentToDisplay ? (
                <UnifiedMarkdown 
                  content={contentToDisplay} 
                  className="text-sm prose prose-sm dark:prose-invert max-w-none [&>:first-child]:mt-0 [&>:last-child]:mb-0" 
                />
              ) : (
                <span className="text-muted-foreground">Receiving task...</span>
              )}
            </div>
            
            {/* Gradients only during streaming */}
            {isExecuting && (
              <>
                <div className="absolute top-0 left-0 right-0 h-6 pointer-events-none bg-gradient-to-b from-zinc-100 dark:from-neutral-900 to-transparent" />
                <div className="absolute bottom-0 left-0 right-0 h-6 pointer-events-none bg-gradient-to-t from-zinc-100 dark:from-neutral-900 to-transparent" />
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default SubAgentInline;
