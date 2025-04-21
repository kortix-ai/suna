import React from "react";
import { ToolViewProps } from "./types";
import { formatTimestamp } from "./utils";
import { ExternalLink, CheckCircle, AlertTriangle } from "lucide-react";
import { Markdown } from "@/components/ui/markdown";
import { cn } from "@/lib/utils";

export function ExposePortToolView({ 
  name = 'expose-port', 
  assistantContent, 
  toolContent, 
  isSuccess = true, 
  isStreaming = false,
  assistantTimestamp, 
  toolTimestamp 
}: ToolViewProps) {
  console.log('ExposePortToolView:', { 
    name, 
    assistantContent, 
    toolContent, 
    isSuccess, 
    isStreaming, 
    assistantTimestamp, 
    toolTimestamp 
  });

  // Parse the assistant content
  const parsedAssistantContent = React.useMemo(() => {
    if (!assistantContent) return null;
    try {
      const parsed = JSON.parse(assistantContent);
      return parsed.content;
    } catch (e) {
      console.error('Failed to parse assistant content:', e);
      return null;
    }
  }, [assistantContent]);

  // Parse the tool result
  const toolResult = React.useMemo(() => {
    if (!toolContent) return null;
    try {
      // First parse the outer JSON
      const parsed = JSON.parse(toolContent);
      // Then extract the tool result content
      const match = parsed.content.match(/output='(.*?)'/);
      if (match) {
        const jsonStr = match[1]
          .replace(/\\n/g, '')
          .replace(/\\"/g, '"');
        return JSON.parse(jsonStr);
      }
      return null;
    } catch (e) {
      console.error('Failed to parse tool content:', e);
      return null;
    }
  }, [toolContent]);

  // Extract port number from assistant content
  const portNumber = React.useMemo(() => {
    if (!parsedAssistantContent) return null;
    try {
      const match = parsedAssistantContent.match(/<expose-port>\s*(\d+)\s*<\/expose-port>/);
      return match ? match[1] : null;
    } catch (e) {
      console.error('Failed to extract port number:', e);
      return null;
    }
  }, [parsedAssistantContent]);

  // If we have no content to show, render a placeholder
  if (!portNumber && !toolResult && !isStreaming) {
    return (
      <div className="flex flex-col h-full p-4">
        <div className="text-xs text-zinc-500 dark:text-zinc-400">
          No port exposure information available
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 p-4 overflow-auto">
        {/* Assistant Content */}
        {portNumber && !isStreaming && (
          <div className="space-y-1.5">
            <div className="flex justify-between items-center">
              <div className="text-xs font-medium text-zinc-500 dark:text-zinc-400">Port to Expose</div>
              {assistantTimestamp && (
                <div className="text-xs text-zinc-500 dark:text-zinc-400">{formatTimestamp(assistantTimestamp)}</div>
              )}
            </div>
            <div className="rounded-md border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900 p-3">
              <div className="flex items-center gap-2">
                <div className="text-xs font-medium text-zinc-800 dark:text-zinc-300">Port</div>
                <div className="px-2 py-1 rounded-md bg-zinc-100 dark:bg-zinc-800 text-xs font-mono text-zinc-800 dark:text-zinc-300">
                  {portNumber}
                </div>
              </div>
            </div>
          </div>
        )}
        
        {/* Tool Result */}
        {toolResult && (
          <div className="space-y-1.5 mt-4">
            <div className="flex justify-between items-center">
              <div className="text-xs font-medium text-zinc-500 dark:text-zinc-400">
                {isStreaming ? "Processing" : "Exposed URL"}
              </div>
              {toolTimestamp && !isStreaming && (
                <div className="text-xs text-zinc-500 dark:text-zinc-400">{formatTimestamp(toolTimestamp)}</div>
              )}
            </div>
            <div className={cn(
              "rounded-md border p-3",
              isStreaming 
                ? 'border-blue-200 bg-blue-50 dark:border-blue-800 dark:bg-blue-900/10' 
                : isSuccess 
                  ? 'border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900' 
                  : 'border-red-200 bg-red-50 dark:border-red-800 dark:bg-red-900/10'
            )}>
              {isStreaming ? (
                <div className="flex items-center gap-2 text-xs font-medium text-blue-700 dark:text-blue-400">
                  <span>Exposing port {portNumber}...</span>
                </div>
              ) : (
                <div className="space-y-3">
                  <div className="flex items-center gap-2">
                    <ExternalLink className="h-4 w-4 text-zinc-500 dark:text-zinc-400" />
                    <a 
                      href={toolResult.url} 
                      target="_blank" 
                      rel="noopener noreferrer"
                      className="text-xs font-medium text-blue-600 dark:text-blue-400 hover:underline break-all"
                    >
                      {toolResult.url}
                    </a>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="text-xs text-zinc-600 dark:text-zinc-400">Port</div>
                    <div className="px-2 py-1 rounded-md bg-zinc-100 dark:bg-zinc-800 text-xs font-mono text-zinc-800 dark:text-zinc-300">
                      {toolResult.port}
                    </div>
                  </div>
                  <div className="text-xs text-zinc-600 dark:text-zinc-400">
                    {toolResult.message}
                  </div>
                  <div className="text-xs text-amber-600 dark:text-amber-400 italic">
                    Note: This URL might only be temporarily available and could expire after some time.
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
      
      {/* Footer */}
      <div className="p-4 border-t border-zinc-200 dark:border-zinc-800">
        <div className="flex items-center justify-between text-xs text-zinc-500 dark:text-zinc-400">
          {!isStreaming && (
            <div className="flex items-center gap-2">
              {isSuccess ? (
                <CheckCircle className="h-3.5 w-3.5 text-emerald-500" />
              ) : (
                <AlertTriangle className="h-3.5 w-3.5 text-red-500" />
              )}
              <span>
                {isSuccess ? 'Port exposed successfully' : 'Failed to expose port'}
              </span>
            </div>
          )}
          
          {isStreaming && (
            <div className="flex items-center gap-2">
              <span>Exposing port...</span>
            </div>
          )}
          
          <div className="text-xs">
            {toolTimestamp && !isStreaming 
              ? formatTimestamp(toolTimestamp) 
              : assistantTimestamp 
                ? formatTimestamp(assistantTimestamp)
                : ''}
          </div>
        </div>
      </div>
    </div>
  );
} 