/**
 * SubAgentInline - Shows sub-agent thread preview
 * 
 * - Streams sub-agent output when running
 * - Fetches last message when complete
 * - Only loads when visible (IntersectionObserver)
 */

import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { CircleDashed, GitBranch, ExternalLink } from 'lucide-react';
import { cn } from '@/lib/utils';
import { UnifiedMarkdown } from '@/components/markdown';
import Link from 'next/link';
import { Project } from '@/lib/api/threads';
import { createClient } from '@/lib/supabase/client';

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
    return {
      task: (taskMatch?.[1] || partialTaskMatch?.[1])?.replace(/\\n/g, '\n').replace(/\\"/g, '"'),
    };
  }
}

function parseResultOutput(output: any): {
  sub_agent_id?: string;
  thread_id?: string;
  task?: string;
  status?: string;
  error?: string;
} {
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
  const observerRef = useRef<HTMLDivElement>(null);

  // Visibility state - only load when visible
  const [isVisible, setIsVisible] = useState(false);
  const [subAgentContent, setSubAgentContent] = useState<string | null>(null);
  const [isLoadingContent, setIsLoadingContent] = useState(false);
  const [contentError, setContentError] = useState<string | null>(null);
  const fetchedRef = useRef(false);

  // Parse result
  const resultData = useMemo(() => {
    if (toolResult?.output) return parseResultOutput(toolResult.output);
    return {};
  }, [toolResult]);

  const isSpawned = !!resultData.sub_agent_id;
  const subAgentThreadId = resultData.thread_id;
  const subAgentStatus = resultData.status;
  const isSubAgentComplete = subAgentStatus === 'completed' || subAgentStatus === 'failed' || subAgentStatus === 'stopped';
  const isExecuting = !isSpawned;

  // Streaming content for spawn phase
  const rawStreamingSource = toolCall.rawArguments || streamingText;
  const [throttledSource, setThrottledSource] = useState(rawStreamingSource);
  const throttleRef = useRef<NodeJS.Timeout | null>(null);
  const lastUpdateRef = useRef<number>(0);

  useEffect(() => {
    if (isSpawned) return;

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
  }, [rawStreamingSource, isSpawned]);

  // Parse streaming args
  const streamingArgs = useMemo(() => {
    if (!isSpawned && throttledSource) {
      return parseStreamingArgs(throttledSource);
    }
    return {};
  }, [isSpawned, throttledSource]);

  // Display values
  const displayTask = streamingArgs.task || toolCall.arguments?.task || resultData.task || '';
  const headerTitle = displayTask
    ? (displayTask.length > 40 ? displayTask.slice(0, 40) + '...' : displayTask)
    : 'Sub-Agent';

  // Link to sub-agent thread
  const linkHref = project?.project_id && subAgentThreadId
    ? `/projects/${project.project_id}?threadId=${subAgentThreadId}`
    : null;

  // IntersectionObserver - only load when visible
  useEffect(() => {
    const el = observerRef.current;
    if (!el) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        setIsVisible(entry.isIntersecting);
      },
      { threshold: 0.1, rootMargin: '100px' }
    );

    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Fetch ALL sub-agent messages when visible and spawned
  const fetchSubAgentContent = useCallback(async () => {
    if (!subAgentThreadId || !isVisible || fetchedRef.current || isLoadingContent) return;

    fetchedRef.current = true;
    setIsLoadingContent(true);
    setContentError(null);

    try {
      const supabase = createClient();
      const { data: { session } } = await supabase.auth.getSession();

      const API_URL = process.env.NEXT_PUBLIC_BACKEND_URL;
      if (!API_URL) throw new Error('API URL not configured');

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (session?.access_token) {
        headers['Authorization'] = `Bearer ${session.access_token}`;
      }

      // Fetch ALL messages in ascending order
      const response = await fetch(
        `${API_URL}/threads/${subAgentThreadId}/messages?order=asc`,
        { headers, cache: 'no-store' }
      );

      if (!response.ok) throw new Error('Failed to fetch');

      const data = await response.json();
      const messages = data.messages || [];

      // Build full content from all assistant messages + tool calls
      const contentParts: string[] = [];

      for (const msg of messages) {
        if (msg.type === 'assistant') {
          // Add text content
          const textContent = msg.metadata?.text_content || msg.content?.content || '';
          if (textContent) {
            contentParts.push(textContent);
          }

          // Parse tool calls
          const toolCalls = msg.metadata?.tool_calls || [];
          for (const tc of toolCalls) {
            const toolName = tc.function_name?.replace(/_/g, ' ') || 'Tool';
            const args = tc.arguments || {};

            // Format tool call info
            if (toolName.toLowerCase().includes('file') || toolName.toLowerCase().includes('create')) {
              const filePath = args.file_path || args.path || '';
              if (filePath) contentParts.push(`\n📄 **${toolName}**: \`${filePath}\``);
            } else if (toolName.toLowerCase().includes('command') || toolName.toLowerCase().includes('execute')) {
              const cmd = args.command || '';
              if (cmd) contentParts.push(`\n💻 **${toolName}**: \`${cmd}\``);
            } else if (toolName.toLowerCase().includes('search') || toolName.toLowerCase().includes('web')) {
              const query = args.query || args.url || '';
              if (query) contentParts.push(`\n🔍 **${toolName}**: ${query}`);
            }
          }
        } else if (msg.type === 'tool') {
          // Parse tool results for key info
          const result = msg.metadata?.result;
          if (result?.success === false && result?.error) {
            contentParts.push(`\n❌ Error: ${result.error}`);
          }
        }
      }

      if (contentParts.length > 0) {
        setSubAgentContent(contentParts.join('\n\n'));
      } else {
        setSubAgentContent('Sub-agent is working...');
      }
    } catch (err) {
      console.error('Failed to fetch sub-agent content:', err);
      setContentError('Failed to load');
    } finally {
      setIsLoadingContent(false);
    }
  }, [subAgentThreadId, isVisible, isLoadingContent]);

  // Trigger fetch when visible and spawned
  useEffect(() => {
    if (isVisible && isSpawned && !fetchedRef.current) {
      fetchSubAgentContent();
    }
  }, [isVisible, isSpawned, fetchSubAgentContent]);

  // Determine what content to show
  const displayContent = useMemo(() => {
    // Still spawning - show task
    if (!isSpawned) {
      return displayTask || null;
    }

    // Spawned - show sub-agent output if available
    if (subAgentContent) {
      return subAgentContent;
    }

    // Loading or error
    if (isLoadingContent) {
      return null; // Will show loading state
    }

    // Fallback to task
    return displayTask || null;
  }, [isSpawned, subAgentContent, isLoadingContent, displayTask]);

  // Status - just for internal tracking, not displayed
  const isRunning = !isSpawned || subAgentStatus === 'running';

  return (
    <div ref={observerRef} className="my-1.5">
      <div className="rounded-xl border bg-card overflow-hidden">
        {/* Header - matches file attachment style */}
        <div className="bg-accent p-2 h-[40px] flex items-center justify-between">
          <div className="flex items-center gap-2 min-w-0">
            <GitBranch className="h-4 w-4 text-primary flex-shrink-0" />
            <span className="text-sm font-medium truncate" title={displayTask}>
              {headerTitle}
            </span>
          </div>
          <div className="flex items-center gap-1">
            {isRunning && (
              <CircleDashed className="h-4 w-4 text-blue-500 flex-shrink-0 animate-spin" />
            )}
            {linkHref && (
              <Link
                href={linkHref}
                target="_blank"
                rel="noopener noreferrer"
                className="p-1 rounded-full hover:bg-black/10 dark:hover:bg-white/10"
                title="Open sub-agent thread"
              >
                <ExternalLink className="h-3.5 w-3.5" />
              </Link>
            )}
          </div>
        </div>

        {/* Content */}
        <div className="relative">
          <div
            ref={containerRef}
            className="max-h-[400px] overflow-y-auto scrollbar-none text-foreground p-3"
            style={!isSpawned ? {
              maskImage: 'linear-gradient(to bottom, transparent 0%, black 8%, black 92%, transparent 100%)',
              WebkitMaskImage: 'linear-gradient(to bottom, transparent 0%, black 8%, black 92%, transparent 100%)'
            } : undefined}
          >
            {isLoadingContent ? (
              <div className="flex items-center gap-2 text-muted-foreground">
                <CircleDashed className="h-3.5 w-3.5 animate-spin" />
                <span className="text-sm">Loading...</span>
              </div>
            ) : contentError ? (
              <span className="text-red-500 text-sm">{contentError}</span>
            ) : displayContent ? (
              <UnifiedMarkdown
                content={displayContent}
                className="text-sm prose prose-sm dark:prose-invert max-w-none [&>:first-child]:mt-0 [&>:last-child]:mb-0"
              />
            ) : (
              <span className="text-muted-foreground text-sm">
                {!isSpawned ? 'Receiving task...' : 'Running...'}
              </span>
            )}
          </div>

          {/* Gradients only during spawn streaming */}
          {!isSpawned && (
            <>
              <div className="absolute top-0 left-0 right-0 h-6 pointer-events-none bg-gradient-to-b from-card to-transparent" />
              <div className="absolute bottom-0 left-0 right-0 h-6 pointer-events-none bg-gradient-to-t from-card to-transparent" />
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export default SubAgentInline;
