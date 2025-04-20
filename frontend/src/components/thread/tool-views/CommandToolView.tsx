import React from "react";
import { Terminal, CheckCircle, AlertTriangle, CircleDashed } from "lucide-react";
import { ToolViewProps } from "./types";
import { extractCommand, extractCommandOutput, extractExitCode, formatTimestamp, getToolTitle } from "./utils";
import { cn } from "@/lib/utils";

export function CommandToolView({ 
  name = "execute-command",
  assistantContent, 
  toolContent,
  assistantTimestamp,
  toolTimestamp,
  isSuccess = true,
  isStreaming = false
}: ToolViewProps) {
  // Clean the command by removing any leading/trailing whitespace and newlines
  const rawCommand = extractCommand(assistantContent);
  // First remove the prompt prefix, then remove any newlines and extra spaces
  const command = rawCommand
    ?.replace(/^suna@computer:~\$\s*/g, '') // Remove prompt prefix
    ?.replace(/\\n/g, '') // Remove escaped newlines
    ?.replace(/\n/g, '') // Remove actual newlines
    ?.trim(); // Clean up any remaining whitespace
  
  // Extract and clean the output
  const rawOutput = extractCommandOutput(toolContent);
  let output = rawOutput;
  
  // Try to parse JSON if the output contains JSON structure
  try {
    if (rawOutput && rawOutput.includes('"output"')) {
      const jsonMatch = rawOutput.match(/"output":\s*"([\s\S]*?)"/);
      if (jsonMatch && jsonMatch[1]) {
        // Replace escaped newlines with actual newlines
        output = jsonMatch[1].replace(/\\n/g, '\n').replace(/\\"/g, '"');
      }
    }
  } catch (e) {
    // If parsing fails, use the original output
    console.error("Error parsing command output:", e);
  }
  
  const exitCode = extractExitCode(toolContent);
  const toolTitle = getToolTitle(name);
  
  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 p-4 overflow-auto">
        <div className="border border-zinc-200 dark:border-zinc-800 rounded-md overflow-hidden h-full flex flex-col">
          <div className="flex items-center p-2 bg-zinc-100 dark:bg-zinc-900 justify-between border-b border-zinc-200 dark:border-zinc-800">
            <div className="flex items-center">
              <Terminal className="h-4 w-4 mr-2 text-zinc-600 dark:text-zinc-400" />
              <span className="text-xs font-medium text-zinc-700 dark:text-zinc-300">Terminal</span>
            </div>
            {exitCode !== null && !isStreaming && (
              <span className={cn(
                "text-xs flex items-center",
                isSuccess ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"
              )}>
                <span className="h-1.5 w-1.5 rounded-full mr-1.5 bg-current"></span>
                Exit: {exitCode}
              </span>
            )}
          </div>
          
          <div className="terminal-container flex-1 overflow-auto bg-black text-zinc-300 font-mono">
            <div className="p-3 text-xs">
              {command && output && !isStreaming && (
                <div className="space-y-2">
                  <div className="flex items-start">
                    <span className="text-emerald-400 shrink-0 mr-2">suna@computer:~$</span>
                    <span className="text-zinc-300">{command}</span>
                  </div>
                  
                  <div className="whitespace-pre-wrap break-words text-zinc-400 pl-0">
                    {output}
                  </div>
                  
                  {isSuccess && <div className="text-emerald-400 mt-1">suna@computer:~$ _</div>}
                </div>
              )}
              
              {command && !output && !isStreaming && (
                <div className="space-y-2">
                  <div className="flex items-start">
                    <span className="text-emerald-400 shrink-0 mr-2">suna@computer:~$</span>
                    <span className="text-zinc-300">{command}</span>
                  </div>
                  <div className="flex items-center h-4">
                    <div className="w-2 h-4 bg-zinc-500 animate-pulse"></div>
                  </div>
                </div>
              )}
              
              {!command && !output && !isStreaming && (
                <div className="flex items-start">
                  <span className="text-emerald-400 shrink-0 mr-2">suna@computer:~$</span>
                  <span className="w-2 h-4 bg-zinc-500 animate-pulse"></span>
                </div>
              )}
              
              {isStreaming && (
                <div className="space-y-2">
                  <div className="flex items-start">
                    <span className="text-emerald-400 shrink-0 mr-2">suna@computer:~$</span>
                    <span className="text-zinc-300">{command || 'running command...'}</span>
                  </div>
                  <div className="flex items-center gap-2 text-zinc-400">
                    <CircleDashed className="h-3 w-3 animate-spin text-blue-400" />
                    <span>Command execution in progress...</span>
                  </div>
                </div>
              )}
            </div>
          </div>
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
                {isSuccess 
                  ? `Command completed successfully${exitCode !== null ? ` (exit code: ${exitCode})` : ''}` 
                  : `Command failed${exitCode !== null ? ` with exit code ${exitCode}` : ''}`}
              </span>
            </div>
          )}
          
          {isStreaming && (
            <div className="flex items-center gap-2">
              <CircleDashed className="h-3.5 w-3.5 text-blue-500 animate-spin" />
              <span>Executing command...</span>
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

