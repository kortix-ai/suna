import React from "react";
import { FileCode, FileSymlink, FolderPlus, FileX, Replace, CheckCircle, AlertTriangle } from "lucide-react";
import { ToolViewProps } from "./types";
import { extractFilePath, extractFileContent, getFileType, formatTimestamp } from "./utils";
import { GenericToolView } from "./GenericToolView";

// Type for operation type
type FileOperation = "create" | "rewrite" | "delete";

export function FileOperationToolView({ 
  assistantContent, 
  toolContent,
  assistantTimestamp,
  toolTimestamp,
  isSuccess = true,
  name
}: ToolViewProps & { name?: string }) {
  // Determine operation type from content or name
  const getOperationType = (): FileOperation => {
    // First check tool name if available
    if (name) {
      if (name.includes("create")) return "create";
      if (name.includes("rewrite")) return "rewrite";
      if (name.includes("delete")) return "delete";
    }
    
    if (!assistantContent) return "create"; // default fallback
    
    if (assistantContent.includes("<create-file>")) return "create";
    if (assistantContent.includes("<full-file-rewrite>")) return "rewrite";
    if (assistantContent.includes("delete-file") || assistantContent.includes("<delete>")) return "delete";
    
    // Check for tool names as a fallback
    if (assistantContent.toLowerCase().includes("create file")) return "create";
    if (assistantContent.toLowerCase().includes("rewrite file")) return "rewrite";
    if (assistantContent.toLowerCase().includes("delete file")) return "delete";
    
    // Default to create if we can't determine
    return "create";
  };

  const operation = getOperationType();
  const filePath = extractFilePath(assistantContent);
  
  // Only extract content for create and rewrite operations
  const fileContent = operation !== "delete" 
    ? extractFileContent(assistantContent, operation === "create" ? 'create-file' : 'full-file-rewrite') 
    : null;
  
  // For debugging - show raw content if file path can't be extracted for delete operations
  const showDebugInfo = !filePath && operation === "delete";
  
  // Fall back to generic view if file path is missing or if content is missing for non-delete operations
  if ((!filePath && !showDebugInfo) || (operation !== "delete" && !fileContent)) {
    return (
      <GenericToolView
        name={`file-${operation}`}
        assistantContent={assistantContent}
        toolContent={toolContent}
        assistantTimestamp={assistantTimestamp}
        toolTimestamp={toolTimestamp}
        isSuccess={isSuccess}
      />
    );
  }
  
  // Operation-specific configs
  const configs = {
    create: {
      title: "Create File",
      icon: FolderPlus,
      color: "text-blue-500",
      bgColor: "bg-blue-50",
      successMessage: "File created successfully"
    },
    rewrite: {
      title: "Rewrite File",
      icon: Replace,
      color: "text-amber-500",
      bgColor: "bg-amber-50",
      successMessage: "File rewritten successfully"
    },
    delete: {
      title: "Delete File",
      icon: FileX,
      color: "text-red-500",
      bgColor: "bg-red-50",
      successMessage: "File deleted successfully"
    }
  };
  
  const config = configs[operation];
  
  // Process file path - handle potential newlines and clean up
  const processedFilePath = filePath ? filePath.trim().replace(/\\n/g, '\n').split('\n')[0] : null;
  
  // For create and rewrite, prepare content for display
  const contentLines = fileContent ? fileContent.replace(/\\n/g, '\n').split('\n') : [];
  const fileName = processedFilePath ? processedFilePath.split('/').pop() || processedFilePath : '';
  const fileType = processedFilePath ? getFileType(processedFilePath) : '';
  const isMarkdown = fileName.endsWith('.md');
  const Icon = config.icon;
  
  return (
    <div className="space-y-4 p-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className={`h-8 w-8 rounded-full ${config.bgColor} flex items-center justify-center`}>
            <Icon className={`h-4 w-4 ${config.color}`} />
          </div>
          <div>
            <h4 className="text-sm font-medium">{config.title}</h4>
            <p className="text-xs text-gray-500 break-all">{processedFilePath}</p>
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
      
      {/* File Content for create and rewrite operations */}
      {operation !== "delete" && fileContent && (
        <div className="border rounded-lg overflow-hidden shadow-sm bg-slate-900">
          {/* IDE Header */}
          <div className="flex items-center p-2 bg-slate-800 text-white justify-between border-b border-slate-700">
            <div className="flex items-center">
              {isMarkdown ? 
                <FileCode className="h-4 w-4 mr-2 text-blue-400" /> :
                <FileSymlink className="h-4 w-4 mr-2 text-blue-400" />
              }
              <span className="text-sm font-medium">{fileName}</span>
            </div>
            <span className="text-xs text-gray-300 bg-slate-700 px-2 py-0.5 rounded">
              {fileType}
            </span>
          </div>
          
          {/* File Content */}
          <div className="overflow-auto max-h-[400px] bg-slate-900 text-slate-200">
            <div className="min-w-full table">
              {contentLines.map((line, idx) => (
                <div key={idx} className="table-row hover:bg-slate-800 transition-colors">
                  <div className="table-cell text-right pr-3 py-0.5 text-xs font-mono text-slate-500 select-none w-12 border-r border-slate-700">
                    {idx + 1}
                  </div>
                  <div className="table-cell pl-3 py-0.5 text-xs font-mono whitespace-pre">
                    {line || ' '}
                  </div>
                </div>
              ))}
              <div className="table-row h-4"></div>
            </div>
          </div>
        </div>
      )}
      
      {/* Debug info for delete operations with missing file path */}
      {showDebugInfo && (
        <div className="border rounded-lg overflow-hidden shadow-sm mb-4">
          <div className="p-4 bg-yellow-50 border-b border-yellow-200">
            <h3 className="text-sm font-medium text-yellow-800">Debug Info: Unable to extract file path</h3>
          </div>
          <div className="p-4 bg-white">
            <h4 className="text-xs font-semibold mb-2">Raw Assistant Content:</h4>
            <pre className="text-xs bg-gray-50 p-3 rounded border overflow-auto max-h-[200px]">
              {assistantContent || "No content"}
            </pre>
          </div>
        </div>
      )}
      
      {/* Delete view with unknown path */}
      {operation === "delete" && !processedFilePath && (
        <div className="border rounded-lg overflow-hidden shadow-sm">
          <div className="p-6 flex flex-col items-center justify-center bg-gray-900 text-white">
            <div className="w-14 h-14 rounded-full bg-red-900/30 flex items-center justify-center mb-4">
              <FileX className="h-7 w-7 text-red-400" />
            </div>
            <h3 className="text-lg font-medium mb-4 text-red-300">File Deleted</h3>
            <div className="bg-gray-800 border border-gray-700 rounded-md p-4 w-full max-w-md text-center mb-2">
              <p className="text-sm text-gray-300">Unknown file path</p>
            </div>
            <p className="text-sm text-gray-400 mt-2">A file has been deleted but the path could not be determined</p>
          </div>

          {/* Status footer */}
          <div className={`p-3 border-t ${
            isSuccess ? 'border-green-800 bg-green-900/20 text-green-400' : 'border-red-800 bg-red-900/20 text-red-400'
          }`}>
            <div className="flex items-center">
              {isSuccess ? (
                <CheckCircle className="h-4 w-4 mr-2 flex-shrink-0" />
              ) : (
                <AlertTriangle className="h-4 w-4 mr-2 flex-shrink-0" />
              )}
              <span className="text-sm">
                {isSuccess ? config.successMessage : `Failed to delete file`}
              </span>
            </div>
          </div>
        </div>
      )}
      
      {/* Delete view */}
      {operation === "delete" && processedFilePath && (
        <div className="border rounded-lg overflow-hidden shadow-sm">
          <div className="p-6 flex flex-col items-center justify-center bg-gray-900 text-white">
            <div className="w-14 h-14 rounded-full bg-red-900/30 flex items-center justify-center mb-4">
              <FileX className="h-7 w-7 text-red-400" />
            </div>
            <h3 className="text-lg font-medium mb-4 text-red-300">File Deleted</h3>
            <div className="bg-gray-800 border border-gray-700 rounded-md p-4 w-full max-w-md text-center mb-2">
              <code className="text-sm font-mono text-gray-300 break-all">{processedFilePath}</code>
            </div>
            <p className="text-sm text-gray-400 mt-2">This file has been permanently removed</p>
          </div>

          {/* Status footer */}
          <div className={`p-3 border-t ${
            isSuccess ? 'border-green-800 bg-green-900/20 text-green-400' : 'border-red-800 bg-red-900/20 text-red-400'
          }`}>
            <div className="flex items-center">
              {isSuccess ? (
                <CheckCircle className="h-4 w-4 mr-2 flex-shrink-0" />
              ) : (
                <AlertTriangle className="h-4 w-4 mr-2 flex-shrink-0" />
              )}
              <span className="text-sm">
                {isSuccess ? config.successMessage : `Failed to delete file`}
              </span>
            </div>
          </div>
        </div>
      )}
      
      {/* Status footer - only show for non-delete operations as delete has its own */}
      {operation !== "delete" && (
        <div className={`mt-2 p-3 rounded-md border ${
          isSuccess ? 'border-green-200 bg-green-50' : 'border-red-200 bg-red-50'
        }`}>
          <div className="flex items-center">
            {isSuccess ? (
              <CheckCircle className="h-4 w-4 text-green-600 mr-2 flex-shrink-0" />
            ) : (
              <AlertTriangle className="h-4 w-4 text-red-600 mr-2 flex-shrink-0" />
            )}
            <span className={`text-sm ${isSuccess ? 'text-green-700' : 'text-red-700'}`}>
              {isSuccess ? config.successMessage : `Failed to ${operation} file`}
            </span>
          </div>
        </div>
      )}
      
      {/* Timestamps */}
      <div className="flex justify-between items-center text-xs text-gray-500 pt-1">
        {assistantTimestamp && (
          <div className="flex items-center">
            <span className="font-medium mr-1">Requested:</span>
            {formatTimestamp(assistantTimestamp)}
          </div>
        )}
        {toolTimestamp && (
          <div className="flex items-center">
            <span className="font-medium mr-1">Completed:</span>
            {formatTimestamp(toolTimestamp)}
          </div>
        )}
      </div>
    </div>
  );
} 