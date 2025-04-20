import React from "react";
import { ToolViewProps } from "./types";
import { formatTimestamp } from "./utils";
import { getToolIcon } from "../utils";
import { CircleDashed } from "lucide-react";
import { Markdown } from "@/components/home/ui/markdown";

export function GenericToolView({ 
  name, 
  assistantContent, 
  toolContent, 
  isSuccess = true, 
  assistantTimestamp, 
  toolTimestamp 
}: ToolViewProps & { name?: string }) {
  const toolName = name || 'Unknown Tool';
  const isStreaming = toolContent === "STREAMING";
  
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
    <div className="space-y-4 p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="h-8 w-8 rounded-full bg-muted flex items-center justify-center">
            {React.createElement(getToolIcon(toolName), { className: "h-4 w-4" })}
          </div>
          <div>
            <h4 className="text-sm font-medium">{toolName}</h4>
          </div>
        </div>
        
        {toolContent && !isStreaming && (
          <div className={`px-2 py-1 rounded-full text-xs ${
            isSuccess ? 'bg-green-50 text-green-700 dark:bg-green-900 dark:text-green-300' 
                      : 'bg-red-50 text-red-700 dark:bg-red-900 dark:text-red-300'
          }`}>
            {isSuccess ? 'Success' : 'Failed'}
          </div>
        )}
        
        {isStreaming && (
          <div className="px-2 py-1 rounded-full text-xs bg-blue-50 text-blue-700 dark:bg-blue-900 dark:text-blue-300 flex items-center gap-1">
            <CircleDashed className="h-3 w-3 animate-spin" />
            <span>Running</span>
          </div>
        )}
      </div>
      
      {/* Tool Parameters */}
      {parsedContent && (
        <div className="space-y-1">
          <div className="flex justify-between items-center">
            <div className="text-xs font-medium text-muted-foreground">Tool Parameters</div>
            {assistantTimestamp && (
              <div className="text-xs text-muted-foreground">{formatTimestamp(assistantTimestamp)}</div>
            )}
          </div>
          <div className="rounded-md border bg-muted/50 p-3">
            {parsedContent.content.startsWith('{') ? (
              // If content looks like JSON, render it prettified
              <pre className="text-xs overflow-auto whitespace-pre-wrap break-words">
                {JSON.stringify(JSON.parse(parsedContent.content), null, 2)}
              </pre>
            ) : (
              // Otherwise render as Markdown
              <Markdown className="text-xs prose prose-xs dark:prose-invert max-w-none">
                {parsedContent.content}
              </Markdown>
            )}
          </div>
        </div>
      )}
      
      {/* Show original assistant content if couldn't parse properly or for debugging */}
      {assistantContent && !parsedContent && !isStreaming && (
        <div className="space-y-1">
          <div className="flex justify-between items-center">
            <div className="text-xs font-medium text-muted-foreground">Assistant Message</div>
            {assistantTimestamp && (
              <div className="text-xs text-muted-foreground">{formatTimestamp(assistantTimestamp)}</div>
            )}
          </div>
          <div className="rounded-md border bg-muted/50 p-3">
            <pre className="text-xs overflow-auto whitespace-pre-wrap break-words">{assistantContent}</pre>
          </div>
        </div>
      )}
      
      {/* Tool Result */}
      {toolContent && (
        <div className="space-y-1">
          <div className="flex justify-between items-center">
            <div className="text-xs font-medium text-muted-foreground">
              {isStreaming ? "Tool Execution" : "Tool Result"}
            </div>
            {toolTimestamp && !isStreaming && (
              <div className="text-xs text-muted-foreground">{formatTimestamp(toolTimestamp)}</div>
            )}
          </div>
          <div className={`rounded-md border p-3 ${
            isStreaming ? 'bg-blue-50/30 dark:bg-blue-900/20' : 
            (isSuccess ? 'bg-muted/50' : 'bg-red-50/30 dark:bg-red-900/20')
          }`}>
            {isStreaming ? (
              <div className="flex items-center gap-2 text-xs text-blue-700 dark:text-blue-300">
                <CircleDashed className="h-3 w-3 animate-spin" />
                <span>Executing {toolName.toLowerCase()}...</span>
              </div>
            ) : (
              <pre className="text-xs overflow-auto whitespace-pre-wrap break-words">{parsedToolContent || toolContent}</pre>
            )}
          </div>
        </div>
      )}
    </div>
  );
} 