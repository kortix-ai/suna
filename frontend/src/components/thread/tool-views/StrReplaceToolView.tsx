import React from "react";
import { FileSearch, FileDiff, CheckCircle, AlertTriangle, CircleDashed } from "lucide-react";
import { ToolViewProps } from "./types";
import { extractFilePath, extractStrReplaceContent, formatTimestamp, getToolTitle } from "./utils";
import { GenericToolView } from "./GenericToolView";
import { cn } from "@/lib/utils";

export function StrReplaceToolView({ 
  name = "str-replace",
  assistantContent, 
  toolContent,
  assistantTimestamp,
  toolTimestamp,
  isSuccess = true,
  isStreaming = false
}: ToolViewProps) {
  const filePath = extractFilePath(assistantContent);
  const { oldStr, newStr } = extractStrReplaceContent(assistantContent);
  const toolTitle = getToolTitle(name);
  
  if (!oldStr || !newStr) {
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
  
  // Perform a character-level diff to identify changes
  const generateDiff = (oldText: string, newText: string) => {
    let i = 0;
    let j = 0;
    
    // Find common prefix length
    let prefixLength = 0;
    while (prefixLength < oldText.length && prefixLength < newText.length && 
          oldText[prefixLength] === newText[prefixLength]) {
      prefixLength++;
    }
    
    // Find common suffix length
    let oldSuffixStart = oldText.length;
    let newSuffixStart = newText.length;
    while (oldSuffixStart > prefixLength && newSuffixStart > prefixLength &&
          oldText[oldSuffixStart - 1] === newText[newSuffixStart - 1]) {
      oldSuffixStart--;
      newSuffixStart--;
    }
    
    // Generate unified diff parts
    const parts = [];
    
    // Add common prefix
    if (prefixLength > 0) {
      parts.push({ text: oldText.substring(0, prefixLength), type: 'unchanged' });
    }
    
    // Add the changed middle parts
    if (oldSuffixStart > prefixLength) {
      parts.push({ text: oldText.substring(prefixLength, oldSuffixStart), type: 'removed' });
    }
    if (newSuffixStart > prefixLength) {
      parts.push({ text: newText.substring(prefixLength, newSuffixStart), type: 'added' });
    }
    
    // Add common suffix
    if (oldSuffixStart < oldText.length) {
      parts.push({ text: oldText.substring(oldSuffixStart), type: 'unchanged' });
    }
    
    return parts;
  };
  
  const diffParts = generateDiff(oldStr, newStr);
  
  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 p-4 overflow-auto">
        <div className="border border-zinc-200 dark:border-zinc-800 rounded-md overflow-hidden h-full flex flex-col">
          <div className="flex items-center p-2 bg-zinc-100 dark:bg-zinc-900 justify-between border-b border-zinc-200 dark:border-zinc-800">
            <div className="flex items-center">
              <FileDiff className="h-4 w-4 mr-2 text-zinc-600 dark:text-zinc-400" />
              <span className="text-xs font-medium text-zinc-700 dark:text-zinc-300">String Replacement</span>
            </div>
          </div>
          
          <div className="px-3 py-2 border-b border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900 flex items-center">
            <code className="text-xs font-mono text-zinc-700 dark:text-zinc-300">{filePath || 'Unknown file'}</code>
          </div>
          
          {isStreaming ? (
            <div className="flex-1 bg-white dark:bg-zinc-950 flex items-center justify-center">
              <div className="text-center p-6">
                <CircleDashed className="h-8 w-8 mx-auto mb-3 text-blue-500 animate-spin" />
                <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300">Processing string replacement...</p>
                {filePath && (
                  <p className="text-xs mt-1 text-zinc-500 dark:text-zinc-400 font-mono">{filePath}</p>
                )}
              </div>
            </div>
          ) : (
            <div className="p-3 bg-white dark:bg-zinc-950 font-mono text-sm flex-1">
              {diffParts.map((part, i) => (
                <span 
                  key={i} 
                  className={cn(
                    part.type === 'removed' ? 'bg-red-50 text-red-700 dark:bg-red-900/20 dark:text-red-400 line-through mx-0.5' : 
                    part.type === 'added' ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-400 mx-0.5' : 
                    'text-zinc-700 dark:text-zinc-300'
                  )}
                >
                  {part.text}
                </span>
              ))}
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
                {isSuccess ? 'Replacement applied successfully' : 'Replacement failed'}
              </span>
            </div>
          )}
          
          {isStreaming && (
            <div className="flex items-center gap-2">
              <CircleDashed className="h-3.5 w-3.5 text-blue-500 animate-spin" />
              <span>Processing string replacement...</span>
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