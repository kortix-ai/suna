import React from "react";
import { FileSearch, FileDiff, CheckCircle, AlertTriangle } from "lucide-react";
import { ToolViewProps } from "./types";
import { extractFilePath, extractStrReplaceContent, formatTimestamp } from "./utils";
import { GenericToolView } from "./GenericToolView";

export function StrReplaceToolView({ 
  assistantContent, 
  toolContent,
  assistantTimestamp,
  toolTimestamp,
  isSuccess = true
}: ToolViewProps) {
  const filePath = extractFilePath(assistantContent);
  const { oldStr, newStr } = extractStrReplaceContent(assistantContent);
  
  if (!oldStr || !newStr) {
    return (
      <GenericToolView
        name="str-replace"
        assistantContent={assistantContent}
        toolContent={toolContent}
        assistantTimestamp={assistantTimestamp}
        toolTimestamp={toolTimestamp}
        isSuccess={isSuccess}
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
    <div className="space-y-4 p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="h-8 w-8 rounded-full bg-muted flex items-center justify-center">
            <FileSearch className="h-4 w-4" />
          </div>
          <div>
            <h4 className="text-sm font-medium">String Replace</h4>
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
            <FileDiff className="h-4 w-4 mr-2 text-muted-foreground" />
            <span className="text-sm font-medium">File Changes</span>
          </div>
        </div>
        
        <div className="px-3 py-2 border-t border-b bg-muted/50 flex items-center">
          <code className="text-xs font-mono">{filePath || 'Unknown file'}</code>
        </div>
        
        <div className="p-3 bg-gray-50 font-mono text-sm">
          {diffParts.map((part, i) => (
            <span 
              key={i} 
              className={
                part.type === 'removed' ? 'bg-red-200 text-red-800 line-through mx-0.5' : 
                part.type === 'added' ? 'bg-green-200 text-green-800 mx-0.5' : ''
              }
            >
              {part.text}
            </span>
          ))}
        </div>
        
        {isSuccess && (
          <div className="border-t px-4 py-2 bg-green-50 flex items-center">
            <CheckCircle className="h-4 w-4 text-green-600 mr-2" />
            <span className="text-xs text-green-700">Replacement applied successfully</span>
          </div>
        )}
        
        {!isSuccess && (
          <div className="border-t px-4 py-2 bg-red-50 flex items-center">
            <AlertTriangle className="h-4 w-4 text-red-600 mr-2" />
            <span className="text-xs text-red-700">Replacement failed</span>
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