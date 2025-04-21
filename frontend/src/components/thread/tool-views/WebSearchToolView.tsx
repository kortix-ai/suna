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
  console.log({
    name,
    assistantContent,
    toolContent,
    assistantTimestamp,
    toolTimestamp,
    isSuccess,
    isStreaming
  });
  const query = extractSearchQuery(assistantContent);
  const searchResults = extractSearchResults(toolContent);
  const toolTitle = getToolTitle(name);
  
  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 p-4 overflow-auto">
        <div className="h-full flex flex-col">
          <div className="flex items-center p-2 justify-between mb-3">
            <div className="flex items-center">
              <Search className="h-4 w-4 mr-2 text-zinc-500 dark:text-zinc-400" />
              <span className="text-xs font-medium text-zinc-600 dark:text-zinc-300">Search Results</span>
            </div>
          </div>
          
          <div className="px-2 mb-4">
            <div className="flex items-center bg-zinc-100 dark:bg-zinc-800/50 rounded p-2">
              <div className="text-xs font-medium mr-2 text-zinc-600 dark:text-zinc-400 shrink-0">Query:</div>
              <div className="text-xs flex-1 text-zinc-800 dark:text-zinc-300 truncate">{query || 'Unknown query'}</div>
            </div>
            <div className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
              {isStreaming ? 'Searching...' : searchResults.length > 0 ? `Found ${searchResults.length} results` : 'No results found'}
            </div>
          </div>
          
          <div className="flex-1 overflow-auto bg-white dark:bg-zinc-950 rounded-md border border-zinc-200 dark:border-zinc-800">
            {isStreaming ? (
              <div className="p-6 text-center flex-1 flex flex-col items-center justify-center h-full">
                <CircleDashed className="h-6 w-6 mx-auto mb-2 text-blue-500 animate-spin" />
                <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300">Searching the web...</p>
                <p className="text-xs mt-1 text-zinc-500 dark:text-zinc-400">This might take a moment</p>
              </div>
            ) : searchResults.length > 0 ? (
              <div className="divide-y divide-zinc-100 dark:divide-zinc-800">
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
            ) : (
              <div className="p-6 text-center text-zinc-500 flex-1 flex flex-col items-center justify-center h-full">
                <Search className="h-6 w-6 mx-auto mb-2 opacity-40" />
                <p className="text-sm font-medium text-zinc-600 dark:text-zinc-300">No results found</p>
                <p className="text-xs mt-1 text-zinc-500 dark:text-zinc-400">Try refining your search query</p>
              </div>
            )}
          </div>
        </div>
      </div>
      
      <div className="p-3 border-t border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900/50">
        <div className="flex items-center justify-between text-xs text-zinc-500 dark:text-zinc-400">
          {!isStreaming && (
            <div className="flex items-center gap-1.5">
              {isSuccess ? (
                <CheckCircle className="h-3.5 w-3.5 text-emerald-500" />
              ) : (
                <AlertTriangle className="h-3.5 w-3.5 text-red-500" />
              )}
              <span>
                {isSuccess ? 'Search completed' : 'Search failed'}
              </span>
            </div>
          )}
          
          {isStreaming && (
            <div className="flex items-center gap-1.5">
              <CircleDashed className="h-3.5 w-3.5 text-blue-500 animate-spin" />
              <span>Searching...</span>
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