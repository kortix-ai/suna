import React from "react";
import { Globe, MonitorPlay, ExternalLink, CheckCircle, AlertTriangle, CircleDashed } from "lucide-react";
import { ToolViewProps } from "./types";
import { extractBrowserUrl, extractBrowserOperation, formatTimestamp, getToolTitle } from "./utils";
import { ApiMessageType } from '@/components/thread/types';
import { safeJsonParse } from '@/components/thread/utils';
import { cn } from "@/lib/utils";

export function BrowserToolView({ 
  name = "browser-operation",
  assistantContent, 
  toolContent,
  assistantTimestamp,
  toolTimestamp,
  isSuccess = true,
  isStreaming = false,
  project,
  agentStatus = 'idle',
  messages = [],
  currentIndex = 0,
  totalCalls = 1
}: ToolViewProps) {
  const url = extractBrowserUrl(assistantContent);
  const operation = extractBrowserOperation(name);
  const toolTitle = getToolTitle(name);
  
  // --- message_id Extraction Logic --- 
  let browserStateMessageId: string | undefined;
  
  try {
    // 1. Parse the top-level JSON
    const topLevelParsed = safeJsonParse<{ content?: string }>(toolContent, {});
    const innerContentString = topLevelParsed?.content;

    if (innerContentString && typeof innerContentString === 'string') {
      // 2. Extract the output='...' string using regex
      const outputMatch = innerContentString.match(/\boutput='(.*?)'(?=\s*\))/);
      const outputString = outputMatch ? outputMatch[1] : null;

      if (outputString) {
        // 3. Unescape the JSON string (basic unescaping for \n and \")
        const unescapedOutput = outputString.replace(/\\n/g, '\n').replace(/\\"/g, '"');
        
        // 4. Parse the unescaped JSON to get message_id
        const finalParsedOutput = safeJsonParse<{ message_id?: string }>(unescapedOutput, {});
        browserStateMessageId = finalParsedOutput?.message_id;
      }
    }
  } catch (error) {
    console.error("[BrowserToolView] Error parsing tool content for message_id:", error);
  }

  // Find the browser_state message and extract the screenshot
  let screenshotBase64: string | null = null;
  if (browserStateMessageId && messages.length > 0) {
    const browserStateMessage = messages.find(msg => 
        (msg.type as string) === 'browser_state' && 
        msg.message_id === browserStateMessageId
    );
    
    if (browserStateMessage) {
        const browserStateContent = safeJsonParse<{ screenshot_base64?: string }>(browserStateMessage.content, {});
        screenshotBase64 = browserStateContent?.screenshot_base64 || null;
    }
  }
  
  // Check if we have a VNC preview URL from the project
  const vncPreviewUrl = project?.sandbox?.vnc_preview ? 
    `${project.sandbox.vnc_preview}/vnc_lite.html?password=${project?.sandbox?.pass}&autoconnect=true&scale=local&width=1024&height=768` : 
    undefined;
  
  const isRunning = isStreaming || agentStatus === 'running';
  const isLastToolCall = currentIndex === (totalCalls - 1);
  
  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 p-4 overflow-auto">
        <div className="border border-zinc-200 dark:border-zinc-800 rounded-md overflow-hidden h-full flex flex-col">
          <div className="bg-zinc-100 dark:bg-zinc-900 p-2 flex items-center justify-between border-b border-zinc-200 dark:border-zinc-800">
            <div className="flex items-center">
              <MonitorPlay className="h-4 w-4 mr-2 text-zinc-600 dark:text-zinc-400" />
              <span className="text-xs font-medium text-zinc-700 dark:text-zinc-300">Browser Window</span>
            </div>
            {url && (
              <div className="text-xs font-mono text-zinc-500 dark:text-zinc-400 truncate max-w-[340px]">
                {url}
              </div>
            )}
          </div>
          
          {/* Preview Logic */}
          <div className="flex-1 flex items-stretch bg-black">
            {isLastToolCall ? (
              // Only show live sandbox or fallback to sandbox for the last tool call
              isRunning && vncPreviewUrl ? (
                <iframe
                  src={vncPreviewUrl}
                  title="Browser preview (Live)"
                  className="w-full h-full border-0 flex-1"
                />
              ) : screenshotBase64 ? (
                <div className="flex items-center justify-center w-full h-full max-h-[650px] overflow-auto">
                  <img 
                    src={`data:image/jpeg;base64,${screenshotBase64}`} 
                    alt="Browser Screenshot"
                    className="max-w-full max-h-full object-contain"
                  />
                </div>
              ) : vncPreviewUrl ? (
                <iframe
                  src={vncPreviewUrl}
                  title="Browser preview"
                  className="w-full h-full border-0 flex-1"
                />
              ) : (
                <div className="p-8 flex flex-col items-center justify-center w-full bg-zinc-50 dark:bg-zinc-900 text-zinc-700 dark:text-zinc-400">
                  <MonitorPlay className="h-12 w-12 mb-3 opacity-40" />
                  <p className="text-sm font-medium">Browser preview not available</p>
                  {url && (
                    <a 
                      href={url} 
                      target="_blank" 
                      rel="noopener noreferrer"
                      className="mt-3 flex items-center text-blue-600 dark:text-blue-500 hover:text-blue-500 dark:hover:text-blue-400 hover:underline"
                    >
                      Visit URL <ExternalLink className="h-3 w-3 ml-1" />
                    </a>
                  )}
                </div>
              )
            ) : (
              // For non-last tool calls, only show screenshot if available, otherwise show "No Browser State image found"
              screenshotBase64 ? (
                <div className="flex items-center justify-center w-full h-full max-h-[650px] overflow-auto">
                  <img 
                    src={`data:image/jpeg;base64,${screenshotBase64}`} 
                    alt="Browser Screenshot"
                    className="max-w-full max-h-full object-contain"
                  />
                </div>
              ) : (
                <div className="p-8 flex flex-col items-center justify-center w-full bg-zinc-50 dark:bg-zinc-900 text-zinc-700 dark:text-zinc-400">
                  <MonitorPlay className="h-12 w-12 mb-3 opacity-40" />
                  <p className="text-sm font-medium">No Browser State image found</p>
                </div>
              )
            )}
          </div>
        </div>
      </div>
      
      {/* Footer */}
      <div className="p-4 border-t border-zinc-200 dark:border-zinc-800">
        <div className="flex items-center justify-between text-xs text-zinc-500 dark:text-zinc-400">
          {!isRunning && (
            <div className="flex items-center gap-2">
              {isSuccess ? (
                <CheckCircle className="h-3.5 w-3.5 text-emerald-500" />
              ) : (
                <AlertTriangle className="h-3.5 w-3.5 text-red-500" />
              )}
              <span>
                {isSuccess ? `${operation} completed successfully` : `${operation} failed`}
              </span>
            </div>
          )}
          
          {isRunning && (
            <div className="flex items-center gap-2">
              <CircleDashed className="h-3.5 w-3.5 text-blue-500 animate-spin" />
              <span>Executing browser action...</span>
            </div>
          )}
          
          <div className="text-xs">
            {toolTimestamp && !isRunning 
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