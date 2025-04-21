import React from "react";
import { ToolViewProps } from "./types";
import { formatTimestamp, getToolTitle } from "./utils";
import { getToolIcon } from "../utils";
import { CircleDashed, CheckCircle, AlertTriangle, Network, Database } from "lucide-react";
import { cn } from "@/lib/utils";

export function DataProviderToolView({ 
  name = 'unknown', 
  assistantContent, 
  toolContent, 
  isSuccess = true, 
  isStreaming = false,
  assistantTimestamp, 
  toolTimestamp 
}: ToolViewProps) {
  const toolTitle = getToolTitle(name);
  const Icon = getToolIcon(name) || Network;
  
  // Extract data from the assistant content (request)
  const extractRequest = React.useMemo(() => {
    if (!assistantContent) return null;
    
    try {
      // Parse assistant content as JSON
      const parsed = JSON.parse(assistantContent);
      
      if (parsed.content) {
        // Try to extract content from service name and route
        const serviceMatch = parsed.content.match(/service_name=\\?"([^"\\]+)\\?"/);
        const routeMatch = parsed.content.match(/route=\\?"([^"\\]+)\\?"/);
        
        // For execute-data-provider-call, also extract the payload
        let payload = null;
        if (name === 'execute-data-provider-call') {
          const payloadMatch = parsed.content.match(/{([^}]+)}/);
          if (payloadMatch) {
            try {
              // Try to parse the payload JSON
              payload = JSON.parse(`{${payloadMatch[1]}}`);
            } catch (e) {
              payload = payloadMatch[1];
            }
          }
        }
        
        return {
          service: serviceMatch ? serviceMatch[1] : undefined,
          route: routeMatch ? routeMatch[1] : undefined,
          payload
        };
      }
    } catch (e) {
      console.error("Error parsing assistant content:", e);
    }
    
    return null;
  }, [assistantContent, name]);
  
  // Parse the tool response
  const parsedResponse = React.useMemo(() => {
    if (!toolContent || isStreaming) return null;
    
    try {
      // Extract content from tool_result tags if present
      const toolResultMatch = toolContent.match(/<tool_result>\s*<[^>]+>([\s\S]*?)<\/[^>]+>\s*<\/tool_result>/);
      let contentToFormat = toolResultMatch ? toolResultMatch[1] : toolContent;
      
      // Look for a ToolResult pattern
      const toolResultOutputMatch = contentToFormat.match(/ToolResult\(success=.+?, output='([\s\S]*?)'\)/);
      if (toolResultOutputMatch) {
        contentToFormat = toolResultOutputMatch[1];
      }
      
      // Try to parse as JSON for pretty formatting
      try {
        // Replace escaped quotes and newlines
        contentToFormat = contentToFormat.replace(/\\"/g, '"').replace(/\\n/g, '\n');
        const parsedJson = JSON.parse(contentToFormat);
        return JSON.stringify(parsedJson, null, 2);
      } catch (e) {
        // If not valid JSON, return as is
        return contentToFormat;
      }
    } catch (e) {
      return toolContent;
    }
  }, [toolContent, isStreaming]);
  
  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 p-4 overflow-auto">
        <div className="border border-zinc-200 dark:border-zinc-800 rounded-md overflow-hidden h-full flex flex-col">
          {/* Header - exactly like other tool views */}
          <div className="flex items-center p-2 bg-zinc-100 dark:bg-zinc-900 justify-between border-b border-zinc-200 dark:border-zinc-800">
            <div className="flex items-center">
              <Database className="h-4 w-4 mr-2 text-zinc-600 dark:text-zinc-400" />
              <span className="text-xs font-medium text-zinc-700 dark:text-zinc-300">{toolTitle}</span>
            </div>
            
            {!isStreaming && (
              <span className={cn(
                "text-xs flex items-center",
                isSuccess ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"
              )}>
                <span className="h-1.5 w-1.5 rounded-full mr-1.5 bg-current"></span>
                {isSuccess ? 'Success' : 'Failed'}
              </span>
            )}
          </div>
          
          {/* Request Info Bar - match style with file paths in other tools */}
          {extractRequest && (
            <div className="px-3 py-2 border-b border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900">
              <code className="text-xs font-mono text-zinc-700 dark:text-zinc-300">
                {extractRequest.service}{extractRequest.route && `/${extractRequest.route}`}
              </code>
            </div>
          )}

          {/* Content Container */}
          {!isStreaming ? (
            <div className="flex-1 bg-white dark:bg-zinc-950 font-mono text-sm">
              <div className="p-3">
                {/* Request section - show payload if available */}
                {extractRequest?.payload && (
                  <div className="mb-4">
                    <div className="text-xs font-medium text-zinc-500 dark:text-zinc-400 mb-2">Request Payload</div>
                    <div className="bg-zinc-50 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-md">
                      <pre className="p-3 text-xs overflow-auto whitespace-pre-wrap text-zinc-800 dark:text-zinc-300 font-mono">
                        {typeof extractRequest.payload === 'object' 
                          ? JSON.stringify(extractRequest.payload, null, 2) 
                          : extractRequest.payload}
                      </pre>
                    </div>
                  </div>
                )}
                
                {/* Response section */}
                {parsedResponse && (
                  <div>
                    <div className="text-xs font-medium text-zinc-500 dark:text-zinc-400 mb-2">Response Data</div>
                    <div className="bg-zinc-50 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-md">
                      <pre className="p-3 text-xs overflow-auto whitespace-pre-wrap text-zinc-800 dark:text-zinc-300 font-mono">
                        {parsedResponse}
                      </pre>
                    </div>
                  </div>
                )}
                
                {/* Show raw data if parsed content isn't available */}
                {!extractRequest?.payload && !parsedResponse && assistantContent && (
                  <div className="mb-4">
                    <div className="text-xs font-medium text-zinc-500 dark:text-zinc-400 mb-2">Raw Request</div>
                    <div className="bg-zinc-50 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-md">
                      <pre className="p-3 text-xs overflow-auto whitespace-pre-wrap text-zinc-800 dark:text-zinc-300 font-mono">
                        {assistantContent}
                      </pre>
                    </div>
                  </div>
                )}
                
                {!parsedResponse && toolContent && (
                  <div>
                    <div className="text-xs font-medium text-zinc-500 dark:text-zinc-400 mb-2">Raw Response</div>
                    <div className="bg-zinc-50 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-md">
                      <pre className="p-3 text-xs overflow-auto whitespace-pre-wrap text-zinc-800 dark:text-zinc-300 font-mono">
                        {toolContent}
                      </pre>
                    </div>
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="flex-1 bg-white dark:bg-zinc-950 flex items-center justify-center">
              <div className="text-center p-6">
                <CircleDashed className="h-8 w-8 mx-auto mb-3 text-blue-500 animate-spin" />
                <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
                  Processing {name.toLowerCase()} operation...
                </p>
                {extractRequest?.service && extractRequest?.route && (
                  <p className="text-xs mt-1 text-zinc-500 dark:text-zinc-400 font-mono">
                    {extractRequest.service}/{extractRequest.route}
                  </p>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
      
      {/* Footer - exactly like other tool views */}
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
                {isSuccess 
                  ? `${toolTitle} completed successfully` 
                  : `${toolTitle} operation failed`}
              </span>
            </div>
          )}
          
          {isStreaming && (
            <div className="flex items-center gap-2">
              <CircleDashed className="h-3.5 w-3.5 text-blue-500 animate-spin" />
              <span>Executing {toolTitle.toLowerCase()}...</span>
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