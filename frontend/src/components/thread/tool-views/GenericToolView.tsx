import React from "react";
import { ToolViewProps } from "./types";
import { formatTimestamp, getToolTitle } from "./utils";
import { getToolIcon } from "../utils";
import { CircleDashed, CheckCircle, AlertTriangle } from "lucide-react";
import { Markdown } from "@/components/ui/markdown";
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
  console.log('GenericToolView:', { 
    name, 
    assistantContent, 
    toolContent, 
    isSuccess, 
    isStreaming, 
    assistantTimestamp, 
    toolTimestamp 
  });
  
  const toolTitle = getToolTitle(name);
  const Icon = getToolIcon(name);
  
  // Format content for display
  const formatContent = (content: string | null) => {
    if (!content) return null;
    
    try {
      // Try to parse as JSON for pretty formatting
      const parsedJson = JSON.parse(content);
      return JSON.stringify(parsedJson, null, 2);
    } catch (e) {
      // If not valid JSON, return as is
      return content;
    }
  };
  
  // Format the contents
  const formattedAssistantContent = React.useMemo(() => formatContent(assistantContent), [assistantContent]);
  const formattedToolContent = React.useMemo(() => formatContent(toolContent), [toolContent]);
  
  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 p-4 overflow-auto">
        {/* Assistant Content */}
        {assistantContent && !isStreaming && (
          <div className="space-y-1.5">
            <div className="flex justify-between items-center">
              <div className="text-xs font-medium text-zinc-500 dark:text-zinc-400">Input</div>
              {assistantTimestamp && (
                <div className="text-xs text-zinc-500 dark:text-zinc-400">{formatTimestamp(assistantTimestamp)}</div>
              )}
            </div>
            <div className="rounded-md border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900 p-3">
              <pre className="text-xs overflow-auto whitespace-pre-wrap break-words text-zinc-800 dark:text-zinc-300 font-mono">{formattedAssistantContent}</pre>
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
                <pre className="text-xs overflow-auto whitespace-pre-wrap break-words text-zinc-800 dark:text-zinc-300 font-mono">{formattedToolContent}</pre>
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