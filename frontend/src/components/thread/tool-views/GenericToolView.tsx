import React from "react";
import { ToolViewProps } from "./types";
import { formatTimestamp, getToolTitle } from "./utils";
import { getToolIcon } from "../utils";
import { CircleDashed, CheckCircle, AlertTriangle } from "lucide-react";
import { Markdown } from "@/components/home/ui/markdown";
import { cn } from "@/lib/utils";

export function GenericToolView({ 
  name = 'unknown', 
  assistantContent, 
  toolContent, 
  isSuccess = true, 
  isStreaming = false,
  assistantTimestamp, 
  toolTimestamp 
}: ToolViewProps) {
  const toolTitle = getToolTitle(name);
  const Icon = getToolIcon(name);
  
  // Parse the assistant content to extract tool parameters
  const parsedContent = React.useMemo(() => {
    if (!assistantContent) return null;
    
    // Try to extract content from XML tags
    const xmlMatch = assistantContent.match(/<([a-zA-Z\-_]+)(?:\s+[^>]*)?>([^<]*)<\/\1>/);
    if (xmlMatch) {
      return {
        tag: xmlMatch[1],
        content: xmlMatch[2].trim()
      };
    }
    
    return null;
  }, [assistantContent]);

  // Parse the tool content to extract result from inside <tool_result> tags
  const parsedToolContent = React.useMemo(() => {
    if (!toolContent || isStreaming) return null;
    
    // Try to extract content from <tool_result> tags
    const toolResultMatch = toolContent.match(/<tool_result>([\s\S]*?)<\/tool_result>/);
    if (toolResultMatch) {
      return toolResultMatch[1].trim();
    }
    
    return toolContent;
  }, [toolContent, isStreaming]);
  
  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 p-4 overflow-auto">
        {/* Tool Parameters */}
        {parsedContent && (
          <div className="space-y-1.5">
            <div className="flex justify-between items-center">
              <div className="text-xs font-medium text-zinc-500 dark:text-zinc-400">Input</div>
              {assistantTimestamp && (
                <div className="text-xs text-zinc-500 dark:text-zinc-400">{formatTimestamp(assistantTimestamp)}</div>
              )}
            </div>
            <div className="rounded-md border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900 p-3">
              {parsedContent.content.startsWith('{') ? (
                <pre className="text-xs overflow-auto whitespace-pre-wrap break-words text-zinc-800 dark:text-zinc-300 font-mono">
                  {JSON.stringify(JSON.parse(parsedContent.content), null, 2)}
                </pre>
              ) : (
                <Markdown className="text-xs prose prose-zinc dark:prose-invert max-w-none">
                  {parsedContent.content}
                </Markdown>
              )}
            </div>
          </div>
        )}
        
        {/* Show original assistant content if couldn't parse properly */}
        {assistantContent && !parsedContent && !isStreaming && (
          <div className="space-y-1.5">
            <div className="flex justify-between items-center">
              <div className="text-xs font-medium text-zinc-500 dark:text-zinc-400">Input</div>
              {assistantTimestamp && (
                <div className="text-xs text-zinc-500 dark:text-zinc-400">{formatTimestamp(assistantTimestamp)}</div>
              )}
            </div>
            <div className="rounded-md border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900 p-3">
              <pre className="text-xs overflow-auto whitespace-pre-wrap break-words text-zinc-800 dark:text-zinc-300 font-mono">{assistantContent}</pre>
            </div>
          </div>
        )}
        
        {/* Tool Result */}
        {toolContent && (
          <div className="space-y-1.5 mt-4">
            <div className="flex justify-between items-center">
              <div className="text-xs font-medium text-zinc-500 dark:text-zinc-400">
                {isStreaming ? "Processing" : "Output"}
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
                  <CircleDashed className="h-3 w-3 animate-spin" />
                  <span>Executing {toolTitle.toLowerCase()}...</span>
                </div>
              ) : (
                <pre className="text-xs overflow-auto whitespace-pre-wrap break-words text-zinc-800 dark:text-zinc-300 font-mono">{parsedToolContent || toolContent}</pre>
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
                {isSuccess ? 'Completed successfully' : 'Execution failed'}
              </span>
            </div>
          )}
          
          {isStreaming && (
            <div className="flex items-center gap-2">
              <CircleDashed className="h-3.5 w-3.5 text-blue-500 animate-spin" />
              <span>Processing...</span>
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