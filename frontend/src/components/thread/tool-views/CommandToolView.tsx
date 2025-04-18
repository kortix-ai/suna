import React from "react";
import { Terminal, CheckCircle, AlertTriangle } from "lucide-react";
import { ToolViewProps } from "./types";
import { extractCommand, extractCommandOutput, extractExitCode, formatTimestamp } from "./utils";

export function CommandToolView({ 
  assistantContent, 
  toolContent,
  assistantTimestamp,
  toolTimestamp,
  isSuccess = true
}: ToolViewProps) {
  // Clean the command by removing any leading/trailing whitespace and newlines
  const rawCommand = extractCommand(assistantContent);
  // First remove the prompt prefix, then remove any newlines and extra spaces
  const command = rawCommand
    ?.replace(/^user@machine:~\$\s*/g, '') // Remove prompt prefix
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
  
  return (
    <div className="space-y-4 p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="h-8 w-8 rounded-full bg-muted flex items-center justify-center">
            <Terminal className="h-4 w-4" />
          </div>
          <div>
            <h4 className="text-sm font-medium">Execute Command</h4>
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
        <div className="flex items-center p-2 bg-zinc-800 justify-between">
          <div className="flex items-center">
            <div className="flex space-x-1.5 mr-3 ml-1">
              <div className="w-3 h-3 rounded-full bg-red-500"></div>
              <div className="w-3 h-3 rounded-full bg-yellow-500"></div>
              <div className="w-3 h-3 rounded-full bg-green-500"></div>
            </div>
            <span className="text-sm font-medium text-gray-200">Terminal</span>
          </div>
          {exitCode !== null && (
            <span className={`text-xs flex items-center ${isSuccess ? 'text-green-400' : 'text-red-400'}`}>
              <span className="h-1.5 w-1.5 rounded-full mr-1.5 bg-current"></span>
              Exit: {exitCode}
            </span>
          )}
        </div>
        
        <div className="terminal-container overflow-auto max-h-[500px] bg-zinc-900 text-gray-200 font-mono">
          <div className="p-4 text-sm">
            {command && output && (
              <div className="space-y-2">
                <div className="flex items-start">
                  <span className="text-green-400 shrink-0 mr-2">user@machine:~$</span>
                  <span className="text-gray-200">{command}</span>
                </div>
                
                <div className="whitespace-pre-wrap break-words text-gray-300 pl-0">
                  {output}
                </div>
                
                {isSuccess && <div className="text-green-400 mt-1">user@machine:~$ _</div>}
              </div>
            )}
            
            {command && !output && (
              <div className="space-y-2">
                <div className="flex items-start">
                  <span className="text-green-400 shrink-0 mr-2">user@machine:~$</span>
                  <span className="text-gray-200">{command}</span>
                </div>
                <div className="flex items-center h-4">
                  <div className="w-2 h-4 bg-gray-300 animate-pulse"></div>
                </div>
              </div>
            )}
            
            {!command && !output && (
              <div className="flex items-start">
                <span className="text-green-400 shrink-0 mr-2">user@machine:~$</span>
                <span className="w-2 h-4 bg-gray-300 animate-pulse"></span>
              </div>
            )}
          </div>
        </div>
        
        {isSuccess && output && exitCode === 0 && (
          <div className="border-t border-zinc-700 px-4 py-2 bg-zinc-800 flex items-center">
            <CheckCircle className="h-4 w-4 text-green-500 mr-2" />
            <span className="text-xs text-green-400">Command completed successfully</span>
          </div>
        )}
        
        {exitCode !== null && !isSuccess && (
          <div className="border-t border-zinc-700 px-4 py-2 bg-zinc-800 flex items-center">
            <AlertTriangle className="h-4 w-4 text-red-500 mr-2" />
            <span className="text-xs text-red-400">Command failed with exit code {exitCode}</span>
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