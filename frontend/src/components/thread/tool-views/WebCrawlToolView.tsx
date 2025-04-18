import React from "react";
import { Globe, ArrowUpRight, Copy, CheckCircle, AlertTriangle } from "lucide-react";
import { ToolViewProps } from "./types";
import { extractCrawlUrl, extractWebpageContent, formatTimestamp } from "./utils";
import { GenericToolView } from "./GenericToolView";

export function WebCrawlToolView({ 
  assistantContent, 
  toolContent,
  assistantTimestamp,
  toolTimestamp,
  isSuccess = true
}: ToolViewProps) {
  const url = extractCrawlUrl(assistantContent);
  const webpageContent = extractWebpageContent(toolContent);
  
  if (!url) {
    return (
      <GenericToolView
        name="crawl-webpage"
        assistantContent={assistantContent}
        toolContent={toolContent}
        assistantTimestamp={assistantTimestamp}
        toolTimestamp={toolTimestamp}
        isSuccess={isSuccess}
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
    if (!text) return [<p key="empty" className="text-gray-400 italic">No content extracted</p>];
    
    return text.split('\n\n').map((paragraph, idx) => {
      if (!paragraph.trim()) return null;
      return (
        <p key={idx} className="mb-3">
          {paragraph.trim()}
        </p>
      );
    }).filter(Boolean);
  };
  
  return (
    <div className="space-y-4 p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="h-8 w-8 rounded-full bg-muted flex items-center justify-center">
            <Globe className="h-4 w-4" />
          </div>
          <div>
            <h4 className="text-sm font-medium">Web Crawl</h4>
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
      
      <div className="border rounded-md overflow-hidden shadow-sm">
        {/* Webpage Header */}
        <div className="flex items-center p-2 bg-gray-800 text-white justify-between">
          <div className="flex items-center">
            <Globe className="h-4 w-4 mr-2 text-blue-400" />
            <span className="text-sm font-medium line-clamp-1 pr-2">
              {webpageContent?.title || domain}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <a 
              href={url} 
              target="_blank" 
              rel="noopener noreferrer"
              className="text-xs text-blue-400 hover:text-blue-300 flex items-center gap-1"
            >
              Visit <ArrowUpRight className="h-3 w-3" />
            </a>
          </div>
        </div>
        
        {/* URL Bar */}
        <div className="px-3 py-1.5 border-t border-gray-700 bg-gray-700 flex items-center justify-between">
          <div className="flex-1 bg-gray-800 rounded px-2 py-1 text-gray-300 flex items-center">
            <code className="text-xs font-mono truncate">{url}</code>
          </div>
          <button className="ml-2 text-gray-400 hover:text-gray-200" title="Copy URL">
            <Copy className="h-3.5 w-3.5" />
          </button>
        </div>
        
        {/* Webpage Content */}
        <div className="overflow-auto bg-white max-h-[500px] p-4">
          {webpageContent ? (
            <div className="prose prose-sm max-w-none">
              <h1 className="text-lg font-bold mb-4">{webpageContent.title}</h1>
              <div className="text-sm">
                {formatTextContent(webpageContent.text)}
              </div>
            </div>
          ) : (
            <div className="p-6 text-center text-muted-foreground">
              <Globe className="h-6 w-6 mx-auto mb-2 opacity-50" />
              <p className="text-sm font-medium">No content extracted</p>
            </div>
          )}
        </div>
        
        {/* Status Footer */}
        {isSuccess ? (
          <div className="border-t px-4 py-2 bg-green-50 flex items-center">
            <CheckCircle className="h-4 w-4 text-green-600 mr-2" />
            <span className="text-xs text-green-700">Webpage crawled successfully</span>
          </div>
        ) : (
          <div className="border-t px-4 py-2 bg-red-50 flex items-center">
            <AlertTriangle className="h-4 w-4 text-red-600 mr-2" />
            <span className="text-xs text-red-700">Failed to crawl webpage</span>
          </div>
        )}
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