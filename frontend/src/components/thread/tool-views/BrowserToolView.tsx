import React from "react";
import { Globe, MonitorPlay, ExternalLink, CheckCircle, AlertTriangle } from "lucide-react";
import { BrowserToolViewProps } from "./types";
import { extractBrowserUrl, extractBrowserOperation, formatTimestamp } from "./utils";
import { ApiMessageType } from '@/components/thread/types';
import { safeJsonParse } from '@/components/thread/utils';

// Define props including messages
export interface BrowserToolViewPropsExtended extends BrowserToolViewProps {
  messages?: ApiMessageType[];
  agentStatus?: string;
  currentIndex?: number;
  totalCalls?: number;
}

export function BrowserToolView({ 
  name,
  assistantContent, 
  toolContent,
  assistantTimestamp,
  toolTimestamp,
  isSuccess = true,
  project,
  agentStatus = 'idle',
  messages = [],
  currentIndex = 0,
  totalCalls = 1
}: BrowserToolViewPropsExtended) {
  const url = extractBrowserUrl(assistantContent);
  const operation = extractBrowserOperation(name);
  
  // --- Revised message_id Extraction Logic --- 
  let browserStateMessageId: string | undefined;
  console.log("[BrowserToolView] Raw Tool Content:", toolContent); 
  try {
    // 1. Parse the top-level JSON
    const topLevelParsed = safeJsonParse<{ content?: string }>(toolContent, {});
    const innerContentString = topLevelParsed?.content;
    console.log("[BrowserToolView] Inner Content String:", innerContentString);

    if (innerContentString && typeof innerContentString === 'string') {
      // 2. Extract the output='...' string using regex
      const outputMatch = innerContentString.match(/\boutput='(.*?)'(?=\s*\))/);
      const outputString = outputMatch ? outputMatch[1] : null;
      console.log("[BrowserToolView] Extracted Output String (raw):", outputString);

      if (outputString) {
        // 3. Unescape the JSON string (basic unescaping for \n and \")
        const unescapedOutput = outputString.replace(/\\n/g, '\n').replace(/\\"/g, '"');
        console.log("[BrowserToolView] Unescaped Output String:", unescapedOutput);
        
        // 4. Parse the unescaped JSON to get message_id
        const finalParsedOutput = safeJsonParse<{ message_id?: string }>(unescapedOutput, {});
        browserStateMessageId = finalParsedOutput?.message_id;
        console.log("[BrowserToolView] Final Parsed Output for message_id:", finalParsedOutput);
      }
    }
  } catch (error) {
    console.error("[BrowserToolView] Error parsing tool content for message_id:", error);
  }
  console.log("[BrowserToolView] Final Extracted browserStateMessageId:", browserStateMessageId);
  // --- End of Revised Logic ---

  console.log("[BrowserToolView] Received messages count:", messages?.length);

  // Find the browser_state message and extract the screenshot
  let screenshotBase64: string | null = null;
  if (browserStateMessageId && messages.length > 0) {
    const browserStateMessage = messages.find(msg => 
        (msg.type as string) === 'browser_state' && 
        msg.message_id === browserStateMessageId
    );
    console.log("[BrowserToolView] Found browserStateMessage:", browserStateMessage);
    if (browserStateMessage) {
        console.log("[BrowserToolView] Browser State Content:", browserStateMessage.content);
        const browserStateContent = safeJsonParse<{ screenshot_base64?: string }>(browserStateMessage.content, {});
        screenshotBase64 = browserStateContent?.screenshot_base64 || null;
        console.log("[BrowserToolView] Extracted screenshotBase64 (first 50 chars):", screenshotBase64?.substring(0, 50));
    }
  }
  
  // Check if we have a VNC preview URL from the project
  const vncPreviewUrl = project?.sandbox?.vnc_preview ? 
    `${project.sandbox.vnc_preview}/vnc_lite.html?password=${project?.sandbox?.pass}&autoconnect=true&scale=local&width=1024&height=768` : 
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
        
        {/* --- Updated Preview Logic --- */}
        {agentStatus === 'running' && vncPreviewUrl && currentIndex === (totalCalls ?? 1) - 1 ? (
          // Show live preview if agent is running, URL exists, AND it's the latest call
          <div className="bg-black w-full relative" style={{ paddingTop: '75%' }}>
            <iframe
              src={vncPreviewUrl}
              title="Browser preview (Live)"
              className="absolute top-0 left-0 w-full h-full border-0"
              style={{ maxHeight: '650px' }}
            />
          </div>
        ) : screenshotBase64 ? (
            // Show screenshot if available (and agent is not running)
            <div className="bg-black w-full relative overflow-hidden" style={{ maxHeight: '650px' }}>
               <img 
                 src={`data:image/jpeg;base64,${screenshotBase64}`} 
                 alt="Browser Screenshot (Final State)"
                 className="w-full h-auto object-contain"
               />
            </div>
        ) : vncPreviewUrl ? (
          // Fallback to VNC preview if agent is not running and no screenshot
          <div className="bg-black w-full relative" style={{ paddingTop: '75%' }}>
            <iframe
              src={vncPreviewUrl}
              title="Browser preview (VNC Fallback)"
              className="absolute top-0 left-0 w-full h-full border-0"
              style={{ maxHeight: '650px' }}
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