import React from "react";
import { Globe, MonitorPlay, ExternalLink, CheckCircle, AlertTriangle } from "lucide-react";
import { BrowserToolViewProps } from "./types";
import { extractBrowserUrl, extractBrowserOperation, formatTimestamp } from "./utils";

export function BrowserToolView({ 
  name,
  assistantContent, 
  toolContent,
  assistantTimestamp,
  toolTimestamp,
  isSuccess = true,
  project
}: BrowserToolViewProps) {
  const url = extractBrowserUrl(assistantContent);
  const operation = extractBrowserOperation(name);
  
  // Check if we have a VNC preview URL from the project
  const vncPreviewUrl = project?.sandbox?.vnc_preview ? 
    `${project.sandbox.vnc_preview}/vnc_lite.html?password=${project?.sandbox?.pass}` : 
    undefined;
  
  return (
    <div className="space-y-4 p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="h-8 w-8 rounded-full bg-muted flex items-center justify-center">
            <Globe className="h-4 w-4" />
          </div>
          <div>
            <h4 className="text-sm font-medium">{operation}</h4>
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
        <div className="bg-muted p-2 flex items-center justify-between border-b">
          <div className="flex items-center">
            <MonitorPlay className="h-4 w-4 mr-2 text-muted-foreground" />
            <span className="text-sm font-medium">Browser Window</span>
          </div>
          {url && (
            <div className="text-xs font-mono text-muted-foreground truncate max-w-[200px]">
              {url}
            </div>
          )}
        </div>
        
        {vncPreviewUrl ? (
          <div className="aspect-video relative bg-black">
            <iframe
              src={vncPreviewUrl}
              title="Browser preview"
              className="w-full h-full"
              style={{ minHeight: "400px" }}
              frameBorder="0"
              allowFullScreen
            />
          </div>
        ) : (
          <div className="p-8 flex flex-col items-center justify-center bg-muted/10 text-muted-foreground">
            <MonitorPlay className="h-12 w-12 mb-3 opacity-40" />
            <p className="text-sm font-medium">Browser preview not available</p>
            {url && (
              <a 
                href={url} 
                target="_blank" 
                rel="noopener noreferrer"
                className="mt-3 flex items-center text-blue-600 hover:underline"
              >
                Visit URL <ExternalLink className="h-3 w-3 ml-1" />
              </a>
            )}
          </div>
        )}
        
        {isSuccess && (
          <div className="px-3 py-2 border-t bg-green-50 text-green-700 text-xs flex items-center">
            <CheckCircle className="h-3 w-3 mr-2" /> 
            {operation} completed successfully
          </div>
        )}
        
        {!isSuccess && (
          <div className="px-3 py-2 border-t bg-red-50 text-red-700 text-xs flex items-center">
            <AlertTriangle className="h-3 w-3 mr-2" /> 
            {operation} failed
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