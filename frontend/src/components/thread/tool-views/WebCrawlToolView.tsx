import React from "react";
import { Globe, ArrowUpRight, Copy, CheckCircle, AlertTriangle, CircleDashed } from "lucide-react";
import { ToolViewProps } from "./types";
import { extractCrawlUrl, extractWebpageContent, formatTimestamp, getToolTitle } from "./utils";
import { GenericToolView } from "./GenericToolView";
import { cn } from "@/lib/utils";

export function WebCrawlToolView({ 
  name = "web-crawl",
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
  
  // Format the extracted text into paragraphs
  const formatTextContent = (text: string): React.ReactNode[] => {
    if (!text) return [<p key="empty" className="text-zinc-500 dark:text-zinc-400 italic">No content extracted</p>];
    
    return text.split('\n\n').map((paragraph, idx) => {
      if (!paragraph.trim()) return null;
      return (
        <p key={idx} className="mb-3 text-zinc-700 dark:text-zinc-300">
          {paragraph.trim()}
        </p>
      );
    }).filter(Boolean);
  };
  
  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 p-4 overflow-auto">
        <div className="border border-zinc-200 dark:border-zinc-800 rounded-md overflow-hidden h-full flex flex-col">
          {/* Webpage Header */}
          <div className="flex items-center p-2 bg-zinc-100 dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 justify-between border-b border-zinc-200 dark:border-zinc-800">
            <div className="flex items-center">
              <Globe className="h-4 w-4 mr-2 text-zinc-600 dark:text-zinc-400" />
              <span className="text-xs font-medium line-clamp-1 pr-2">
                {webpageContent?.title || domain}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <a 
                href={url} 
                target="_blank" 
                rel="noopener noreferrer"
                className="text-xs text-blue-600 dark:text-blue-500 hover:text-blue-500 dark:hover:text-blue-400 flex items-center gap-1"
              >
                Visit <ArrowUpRight className="h-3 w-3" />
              </a>
            </div>
          </div>
          
          {/* URL Bar */}
          <div className="px-3 py-1.5 border-b border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900 flex items-center justify-between">
            <div className="flex-1 bg-zinc-100 dark:bg-zinc-800 rounded px-2 py-1 text-zinc-800 dark:text-zinc-300 flex items-center">
              <code className="text-xs font-mono truncate">{url}</code>
            </div>
            <button className="ml-2 text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-300" title="Copy URL">
              <Copy className="h-3.5 w-3.5" />
            </button>
          </div>
          
          {/* Webpage Content */}
          {isStreaming ? (
            <div className="flex-1 bg-white dark:bg-zinc-950 flex items-center justify-center">
              <div className="text-center p-6">
                <CircleDashed className="h-8 w-8 mx-auto mb-3 text-blue-500 animate-spin" />
                <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300">Crawling webpage...</p>
                <p className="text-xs mt-1 text-zinc-500 dark:text-zinc-400">Fetching content from {domain}</p>
              </div>
            </div>
          ) : (
            <div className="flex-1 overflow-auto bg-white dark:bg-zinc-950 p-4">
              {webpageContent ? (
                <div className="prose prose-sm dark:prose-invert max-w-none">
                  <h1 className="text-lg font-bold mb-4 text-zinc-900 dark:text-zinc-100">{webpageContent.title}</h1>
                  <div className="text-sm">
                    {formatTextContent(webpageContent.text)}
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
                {isSuccess ? 'Webpage crawled successfully' : 'Failed to crawl webpage'}
              </span>
            </div>
          )}
          
          {isStreaming && (
            <div className="flex items-center gap-2">
              <CircleDashed className="h-3.5 w-3.5 text-blue-500 animate-spin" />
              <span>Crawling webpage...</span>
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