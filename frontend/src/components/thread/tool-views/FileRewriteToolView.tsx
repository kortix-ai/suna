import React from "react";
import { FileCode, FileSymlink, Replace, CheckCircle, AlertTriangle } from "lucide-react";
import { ToolViewProps } from "./types";
import { extractFilePath, extractFileContent, getFileType, formatTimestamp } from "./utils";
import { GenericToolView } from "./GenericToolView";

export function FileRewriteToolView({ 
  assistantContent, 
  toolContent,
  assistantTimestamp,
  toolTimestamp,
  isSuccess = true
}: ToolViewProps) {
  const filePath = extractFilePath(assistantContent);
  const fileContent = extractFileContent(assistantContent, 'full-file-rewrite');
  
  if (!filePath || !fileContent) {
    return (
      <GenericToolView
        name="file-rewrite"
        assistantContent={assistantContent}
        toolContent={toolContent}
        assistantTimestamp={assistantTimestamp}
        toolTimestamp={toolTimestamp}
        isSuccess={isSuccess}
      />
    );
  }
  
  // Split content into lines for line numbering
  const contentLines = fileContent.split('\n');
  const fileType = getFileType(filePath);
  const fileName = filePath.split('/').pop() || filePath;
  const isMarkdown = fileName.endsWith('.md');
  
  return (
    <div className="space-y-4 p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="h-8 w-8 rounded-full bg-muted flex items-center justify-center">
            <Replace className="h-4 w-4" />
          </div>
          <div>
            <h4 className="text-sm font-medium">File Rewrite</h4>
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
        {/* IDE Header */}
        <div className="flex items-center p-2 bg-gray-800 text-white justify-between">
          <div className="flex items-center">
            {isMarkdown ? 
              <FileCode className="h-4 w-4 mr-2 text-blue-400" /> :
              <FileSymlink className="h-4 w-4 mr-2 text-blue-400" />
            }
            <span className="text-sm font-medium">{fileName}</span>
          </div>
          <span className="text-xs text-gray-400 bg-gray-700 px-2 py-0.5 rounded">
            {fileType}
          </span>
        </div>
        
        {/* File Path Bar */}
        <div className="px-3 py-1.5 border-t border-gray-700 bg-gray-700 flex items-center">
          <div className="flex items-center space-x-1 text-gray-300">
            <Replace className="h-3.5 w-3.5" />
            <code className="text-xs font-mono">{filePath}</code>
          </div>
        </div>
        
        {/* IDE Content Area */}
        <div className="overflow-auto bg-gray-900 max-h-[500px] text-gray-200">
          <div className="min-w-full table">
            {contentLines.map((line, idx) => (
              <div key={idx} className="table-row hover:bg-gray-800/50 group">
                <div className="table-cell text-right pr-4 py-0.5 text-xs font-mono text-gray-500 select-none w-12 border-r border-gray-700">
                  {idx + 1}
                </div>
                <div className="table-cell pl-4 py-0.5 text-xs font-mono whitespace-pre">
                  {line || ' '}
                </div>
              </div>
            ))}
            {/* Add an empty line at the end */}
            <div className="table-row h-16"></div>
          </div>
        </div>
        
        {/* Status Footer */}
        {isSuccess ? (
          <div className="border-t border-gray-700 px-4 py-2 bg-green-800/20 flex items-center text-green-400">
            <CheckCircle className="h-4 w-4 mr-2" />
            <span className="text-xs">{fileName} rewritten successfully</span>
          </div>
        ) : (
          <div className="border-t border-gray-700 px-4 py-2 bg-red-800/20 flex items-center text-red-400">
            <AlertTriangle className="h-4 w-4 mr-2" />
            <span className="text-xs">Failed to rewrite file</span>
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