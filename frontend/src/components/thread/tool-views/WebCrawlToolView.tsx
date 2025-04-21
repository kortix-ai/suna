import React from "react";
import { Globe, CheckCircle, AlertTriangle, CircleDashed, ExternalLink } from "lucide-react";
import { ToolViewProps } from "./types";
import { extractCrawlUrl, extractWebpageContent, formatTimestamp, getToolTitle } from "./utils";
import { GenericToolView } from "./GenericToolView";
import { cn } from "@/lib/utils";

export function WebCrawlToolView({ 
  name = "crawl-webpage",
  assistantContent, 
  toolContent,
  assistantTimestamp,
  toolTimestamp,
  isSuccess = true,
  isStreaming = false
}: ToolViewProps) {
  const url = extractCrawlUrl(assistantContent);
  const webpageContent = extractWebpageContent(toolContent);
  const toolTitle = getToolTitle(name);
  
  if (!url) {
    return (
      <GenericToolView
        name={name}
        assistantContent={assistantContent}
        toolContent={toolContent}
        assistantTimestamp={assistantTimestamp}
        toolTimestamp={toolTimestamp}
        isSuccess={isSuccess}
        isStreaming={isStreaming}
      />
    );
  }
  
  // Format domain for display
  const formatDomain = (url: string): string => {
    try {
      const urlObj = new URL(url);
      return urlObj.hostname.replace('www.', '');
    } catch (e) {
      return url;
    }
  };
  
  const domain = url ? formatDomain(url) : 'Unknown';
  
  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 p-4 overflow-auto">
        <div className="border border-zinc-200 dark:border-zinc-800 rounded-md overflow-hidden h-full flex flex-col">
          {/* Webpage Header */}
          <div className="flex items-center p-2 bg-zinc-100 dark:bg-zinc-900 justify-between border-b border-zinc-200 dark:border-zinc-800">
            <div className="flex items-center">
              <Globe className="h-4 w-4 mr-2 text-zinc-600 dark:text-zinc-400" />
              <span className="text-xs font-medium text-zinc-700 dark:text-zinc-300">
                {toolTitle}
              </span>
            </div>
            
            {!isStreaming && (
              <div className="flex items-center gap-2">
                <span className={cn(
                  "text-xs flex items-center",
                  isSuccess ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"
                )}>
                  <span className="h-1.5 w-1.5 rounded-full mr-1.5 bg-current"></span>
                  {isSuccess ? 'Success' : 'Failed'}
                </span>
                
                <a 
                  href={url} 
                  target="_blank" 
                  rel="noopener noreferrer"
                  className="flex items-center gap-1.5 py-1 px-2 text-xs text-zinc-700 dark:text-zinc-300 bg-zinc-200 dark:bg-zinc-800 hover:bg-zinc-300 dark:hover:bg-zinc-700 rounded transition-colors"
                >
                  <ExternalLink className="h-3.5 w-3.5 text-zinc-500 flex-shrink-0" />
                  <span>Open URL</span>
                </a>
              </div>
            )}
          </div>
          
          {/* URL Bar */}
          <div className="px-3 py-2 border-b border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900">
            <code className="text-xs font-mono text-zinc-700 dark:text-zinc-300">{url}</code>
          </div>
          
          {/* Content */}
          {isStreaming ? (
            <div className="flex-1 bg-white dark:bg-zinc-950 flex items-center justify-center">
              <div className="text-center p-6">
                <CircleDashed className="h-8 w-8 mx-auto mb-3 text-blue-500 animate-spin" />
                <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300">Crawling webpage...</p>
                <p className="text-xs mt-1 text-zinc-500 dark:text-zinc-400">Fetching content from {domain}</p>
              </div>
            </div>
          ) : (
            <div className="flex-1 overflow-auto bg-white dark:bg-zinc-950 font-mono text-sm">
              {webpageContent ? (
                <div className="p-3">
                  <div className="text-xs font-medium text-zinc-500 dark:text-zinc-400 mb-2">Page Content</div>
                  <div className="bg-zinc-50 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-md">
                    <pre className="p-3 text-xs overflow-auto whitespace-pre-wrap text-zinc-800 dark:text-zinc-300 font-mono">
                      {webpageContent.text || "No content extracted"}
                    </pre>
                  </div>                  
                </div>
              ) : (
                <div className="p-6 h-full flex items-center justify-center">
                  <div className="text-center">
                    <Globe className="h-6 w-6 mx-auto mb-2 text-zinc-400 dark:text-zinc-500" />
                    <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300">No content extracted</p>
                    <p className="text-xs mt-1 text-zinc-500 dark:text-zinc-400">The webpage might be restricted or empty</p>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
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