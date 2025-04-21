import React from "react";
import { Search, CircleDashed, CheckCircle, AlertTriangle, ExternalLink } from "lucide-react";
import { ToolViewProps } from "./types";
import { extractSearchQuery, extractSearchResults, cleanUrl, formatTimestamp, getToolTitle } from "./utils";
import { cn } from "@/lib/utils";

export function WebSearchToolView({ 
  name = "web-search",
  assistantContent, 
  toolContent,
  assistantTimestamp,
  toolTimestamp,
  isSuccess = true,
  isStreaming = false
}: ToolViewProps) {
  const query = extractSearchQuery(assistantContent);
  const searchResults = extractSearchResults(toolContent);
  const toolTitle = getToolTitle(name);
  
  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 p-4 overflow-auto">
        <div className="border border-zinc-200 dark:border-zinc-800 rounded-md overflow-hidden h-full flex flex-col">
          <div className="flex items-center p-2 bg-zinc-100 dark:bg-zinc-900 justify-between border-b border-zinc-200 dark:border-zinc-800">
            <div className="flex items-center">
              <Search className="h-4 w-4 mr-2 text-zinc-600 dark:text-zinc-400" />
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
          
          <div className="px-3 py-2 border-b border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900">
            <code className="text-xs font-mono text-zinc-700 dark:text-zinc-300">{query || 'Unknown query'}</code>
          </div>
          
          <div className="flex-1 overflow-auto bg-white dark:bg-zinc-950 font-mono text-sm">
            {isStreaming ? (
              <div className="flex-1 flex items-center justify-center">
                <div className="text-center p-6">
                  <CircleDashed className="h-8 w-8 mx-auto mb-3 text-blue-500 animate-spin" />
                  <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300">Searching the web...</p>
                  <p className="text-xs mt-1 text-zinc-500 dark:text-zinc-400">This might take a moment</p>
                </div>
              </div>
            ) : searchResults.length > 0 ? (
              <div className="p-3">
                <div className="text-xs font-medium text-zinc-500 dark:text-zinc-400 mb-3">
                  Found {searchResults.length} results
                </div>
                <div className="divide-y divide-zinc-100 dark:divide-zinc-800 bg-zinc-50 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-md">
                  {searchResults.map((result, idx) => (
                    <div key={idx} className="p-3 space-y-1">
                      <div className="flex flex-col">
                        <div className="text-xs text-zinc-500 dark:text-zinc-400 truncate mb-0.5">
                          {cleanUrl(result.url)}
                        </div>
                        <a 
                          href={result.url} 
                          target="_blank" 
                          rel="noopener noreferrer"
                          className="text-sm text-blue-600 dark:text-blue-400 hover:underline font-medium flex items-center gap-1"
                        >
                          {result.title}
                          <ExternalLink className="h-3 w-3 opacity-60" />
                        </a>
                      </div>
                      {result.snippet && (
                        <p className="text-xs text-zinc-600 dark:text-zinc-400 line-clamp-2">
                          {result.snippet}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <div className="p-6 text-center flex-1 flex flex-col items-center justify-center h-full">
                <Search className="h-6 w-6 mx-auto mb-2 text-zinc-400 dark:text-zinc-500" />
                <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300">No results found</p>
                <p className="text-xs mt-1 text-zinc-500 dark:text-zinc-400">Try refining your search query</p>
              </div>
            )}
          </div>
        </div>
      </div>
      
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
                {isSuccess ? `${toolTitle} completed successfully` : `${toolTitle} operation failed`}
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