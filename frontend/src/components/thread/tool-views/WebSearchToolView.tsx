import React from "react";
import { Search } from "lucide-react";
import { ToolViewProps } from "./types";
import { extractSearchQuery, extractSearchResults, cleanUrl, formatTimestamp } from "./utils";

export function WebSearchToolView({ 
  assistantContent, 
  toolContent,
  assistantTimestamp,
  toolTimestamp,
  isSuccess = true
}: ToolViewProps) {
  const query = extractSearchQuery(assistantContent);
  const searchResults = extractSearchResults(toolContent);
  
  return (
    <div className="space-y-4 p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="h-8 w-8 rounded-full bg-muted flex items-center justify-center">
            <Search className="h-4 w-4" />
          </div>
          <div>
            <h4 className="text-sm font-medium">Web Search</h4>
          </div>
        </div>
        
        {toolContent && (
          <div className={`px-2 py-1 rounded-full text-xs ${
            isSuccess ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'
          }`}>
            {isSuccess ? 'Success' : 'Failed'}
          </div>
        )}
      </div>
      
      <div className="border rounded-md overflow-hidden">
        <div className="flex items-center p-2 bg-muted justify-between">
          <div className="flex items-center">
            <Search className="h-4 w-4 mr-2 text-muted-foreground" />
            <span className="text-sm font-medium">Search Results</span>
          </div>
        </div>
        
        <div className="px-4 py-3 border-t border-b bg-muted/50">
          <div className="flex items-center">
            <div className="text-sm font-medium mr-2">Query:</div>
            <div className="text-sm bg-muted py-1 px-3 rounded-md flex-1">{query || 'Unknown query'}</div>
          </div>
          <div className="mt-1.5 text-xs text-muted-foreground">
            {searchResults.length > 0 ? `Found ${searchResults.length} results` : 'No results found'}
          </div>
        </div>
        
        <div className="overflow-auto bg-muted/20 max-h-[500px]">
          {searchResults.length > 0 ? (
            <div className="divide-y">
              {searchResults.map((result, idx) => (
                <div key={idx} className="p-4 space-y-1.5">
                  <div className="flex flex-col">
                    <div className="text-xs text-emerald-600 truncate">
                      {cleanUrl(result.url)}
                    </div>
                    <a 
                      href={result.url} 
                      target="_blank" 
                      rel="noopener noreferrer"
                      className="text-blue-600 hover:underline font-medium"
                    >
                      {result.title}
                    </a>
                  </div>
                  {result.snippet && (
                    <p className="text-sm text-muted-foreground line-clamp-2">
                      {result.snippet}
                    </p>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <div className="p-6 text-center text-muted-foreground">
              <Search className="h-6 w-6 mx-auto mb-2 opacity-50" />
              <p className="text-sm font-medium">No results found</p>
              <p className="text-xs mt-1">Try a different search query</p>
            </div>
          )}
        </div>
      </div>
      
      <div className="flex justify-between items-center text-xs text-muted-foreground">
        {assistantTimestamp && (
          <div>Called: {formatTimestamp(assistantTimestamp)}</div>
        )}
        {toolTimestamp && (
          <div>Result: {formatTimestamp(toolTimestamp)}</div>
        )}
      </div>
    </div>
  );
} 