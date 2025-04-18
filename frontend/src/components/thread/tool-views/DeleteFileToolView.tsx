import React from "react";
import { FileX, CheckCircle, AlertTriangle } from "lucide-react";
import { ToolViewProps } from "./types";
import { extractFilePath, formatTimestamp } from "./utils";
import { GenericToolView } from "./GenericToolView";

export function DeleteFileToolView({ 
  assistantContent, 
  toolContent,
  assistantTimestamp,
  toolTimestamp,
  isSuccess = true
}: ToolViewProps) {
  const filePath = extractFilePath(assistantContent);
  
  if (!filePath) {
    return (
      <GenericToolView
        name="delete-file"
        assistantContent={assistantContent}
        toolContent={toolContent}
        assistantTimestamp={assistantTimestamp}
        toolTimestamp={toolTimestamp}
        isSuccess={isSuccess}
      />
    );
  }
  
  return (
    <div className="space-y-4 p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="h-8 w-8 rounded-full bg-muted flex items-center justify-center">
            <FileX className="h-4 w-4" />
          </div>
          <div>
            <h4 className="text-sm font-medium">Delete File</h4>
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
        <div className="flex items-center p-2 bg-red-50 text-red-700 justify-between">
          <div className="flex items-center">
            <FileX className="h-4 w-4 mr-2" />
            <span className="text-sm font-medium">File Deleted</span>
          </div>
        </div>
        
        <div className="p-4 flex items-center justify-center">
          <div className="bg-red-50 rounded-md p-3 text-center text-red-700">
            <code className="text-sm font-mono">{filePath}</code>
            <p className="text-xs mt-1">This file has been deleted</p>
          </div>
        </div>
        
        {isSuccess && (
          <div className="border-t px-4 py-2 bg-green-50 flex items-center">
            <CheckCircle className="h-4 w-4 text-green-600 mr-2" />
            <span className="text-xs text-green-700">File deleted successfully</span>
          </div>
        )}
        
        {!isSuccess && (
          <div className="border-t px-4 py-2 bg-red-50 flex items-center">
            <AlertTriangle className="h-4 w-4 text-red-600 mr-2" />
            <span className="text-xs text-red-700">Failed to delete file</span>
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