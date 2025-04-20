import React, { useState } from "react";
import { FileCode, FileSymlink, FolderPlus, FileX, Replace, CheckCircle, AlertTriangle, ExternalLink, CircleDashed, Code, Eye } from "lucide-react";
import { ToolViewProps } from "./types";
import { extractFilePath, extractFileContent, getFileType, formatTimestamp, getToolTitle } from "./utils";
import { GenericToolView } from "./GenericToolView";
import { cn } from "@/lib/utils";

// Type for operation type
type FileOperation = "create" | "rewrite" | "delete";

export function FileOperationToolView({ 
  assistantContent, 
  toolContent,
  assistantTimestamp,
  toolTimestamp,
  isSuccess = true,
  isStreaming = false,
  name,
  project
}: ToolViewProps) {
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
  const toolTitle = getToolTitle(name || `file-${operation}`);
  
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
        name={name || `file-${operation}`}
        assistantContent={assistantContent}
        toolContent={toolContent}
        assistantTimestamp={assistantTimestamp}
        toolTimestamp={toolTimestamp}
        isSuccess={isSuccess}
        isStreaming={isStreaming}
      />
    );
  }
  
  // Operation-specific configs
  const configs = {
    create: {
      icon: FolderPlus,
      successMessage: "File created successfully"
    },
    rewrite: {
      icon: Replace,
      successMessage: "File rewritten successfully"
    },
    delete: {
      icon: FileX,
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
  const isHtml = fileName.endsWith('.html');
  const Icon = config.icon;
  
  // Construct HTML file preview URL if we have a sandbox and the file is HTML
  const htmlPreviewUrl = (isHtml && project?.sandbox?.sandbox_url && processedFilePath) 
    ? `${project.sandbox.sandbox_url}/${processedFilePath}`
    : undefined;
  
  // Add state for view mode toggle (code or preview)
  const [viewMode, setViewMode] = useState<'code' | 'preview'>(isHtml ? 'preview' : 'code');
  
  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 p-4 overflow-auto">
        {/* File Content for create and rewrite operations */}
        {operation !== "delete" && fileContent && !isStreaming && (
          <div className="border border-zinc-200 dark:border-zinc-800 rounded-md overflow-hidden shadow-sm bg-white dark:bg-zinc-950 h-full flex flex-col">
            {/* IDE Header */}
            <div className="flex items-center p-2 bg-zinc-100 dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 justify-between border-b border-zinc-200 dark:border-zinc-800">
              <div className="flex items-center">
                {isMarkdown ? 
                  <FileCode className="h-4 w-4 mr-2 text-zinc-600 dark:text-zinc-400" /> :
                  <FileSymlink className="h-4 w-4 mr-2 text-zinc-600 dark:text-zinc-400" />
                }
                <span className="text-xs font-medium">{fileName}</span>
              </div>
              
              <div className="flex items-center gap-2">
                {/* View switcher for HTML files */}
                {isHtml && htmlPreviewUrl && isSuccess && (
                  <div className="flex rounded-md overflow-hidden border border-zinc-200 dark:border-zinc-700">
                    <button
                      onClick={() => setViewMode('code')}
                      className={cn(
                        "flex items-center gap-1 text-xs px-2 py-1 transition-colors",
                        viewMode === 'code'
                          ? "bg-zinc-800 text-zinc-100 dark:bg-zinc-700 dark:text-zinc-100"
                          : "bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-400 hover:bg-zinc-300 dark:hover:bg-zinc-700"
                      )}
                    >
                      <Code className="h-3 w-3" />
                      <span>Code</span>
                    </button>
                    <button
                      onClick={() => setViewMode('preview')}
                      className={cn(
                        "flex items-center gap-1 text-xs px-2 py-1 transition-colors",
                        viewMode === 'preview'
                          ? "bg-zinc-800 text-zinc-100 dark:bg-zinc-700 dark:text-zinc-100"
                          : "bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-400 hover:bg-zinc-300 dark:hover:bg-zinc-700"
                      )}
                    >
                      <Eye className="h-3 w-3" />
                      <span>Preview</span>
                    </button>
                  </div>
                )}
                <span className="text-xs text-zinc-500 dark:text-zinc-400 bg-zinc-200 dark:bg-zinc-800 px-2 py-0.5 rounded">
                  {fileType}
                </span>
              </div>
            </div>
            
            {/* File Content */}
            {(!isHtml || viewMode === 'code' || !htmlPreviewUrl || !isSuccess) && (
              <div className="flex-1 overflow-auto bg-white dark:bg-zinc-950 text-zinc-900 dark:text-zinc-100">
                <div className="min-w-full table">
                  {contentLines.map((line, idx) => (
                    <div key={idx} className="table-row hover:bg-zinc-50 dark:hover:bg-zinc-900 transition-colors">
                      <div className="table-cell text-right pr-3 py-0.5 text-xs font-mono text-zinc-500 dark:text-zinc-500 select-none w-12 border-r border-zinc-200 dark:border-zinc-800">
                        {idx + 1}
                      </div>
                      <div className="table-cell pl-3 py-0.5 text-xs font-mono whitespace-pre text-zinc-800 dark:text-zinc-300">
                        {line || ' '}
                      </div>
                    </div>
                  ))}
                  <div className="table-row h-4"></div>
                </div>
              </div>
            )}
            
            {/* HTML Preview with iframe */}
            {isHtml && viewMode === 'preview' && htmlPreviewUrl && isSuccess && (
              <div className="flex-1 bg-white overflow-hidden">
                <iframe 
                  src={htmlPreviewUrl}
                  title={`HTML Preview of ${fileName}`}
                  className="w-full h-full border-0"
                  style={{ minHeight: "300px" }}
                  sandbox="allow-same-origin allow-scripts"
                />
              </div>
            )}
            
            {/* External link button for HTML files */}
            {isHtml && viewMode === 'preview' && htmlPreviewUrl && isSuccess && (
              <div className="bg-zinc-100 dark:bg-zinc-900 p-2 border-t border-zinc-200 dark:border-zinc-800 flex justify-end">
                <a 
                  href={htmlPreviewUrl} 
                  target="_blank" 
                  rel="noopener noreferrer"
                  className="flex items-center gap-1.5 py-1 px-2 text-xs text-zinc-700 dark:text-zinc-300 bg-zinc-200 dark:bg-zinc-800 hover:bg-zinc-300 dark:hover:bg-zinc-700 rounded transition-colors"
                >
                  <ExternalLink className="h-3.5 w-3.5 text-zinc-500 flex-shrink-0" />
                  <span>Open in Browser</span>
                </a>
              </div>
            )}
          </div>
        )}
        
        {/* File Content for streaming state */}
        {operation !== "delete" && isStreaming && (
          <div className="border border-zinc-200 dark:border-zinc-800 rounded-md overflow-hidden shadow-sm bg-white dark:bg-zinc-950 h-full flex flex-col">
            {/* IDE Header */}
            <div className="flex items-center p-2 bg-zinc-100 dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 justify-between border-b border-zinc-200 dark:border-zinc-800">
              <div className="flex items-center">
                <FileSymlink className="h-4 w-4 mr-2 text-zinc-600 dark:text-zinc-400" />
                <span className="text-xs font-medium">{fileName || 'file.txt'}</span>
              </div>
              <span className="text-xs text-zinc-500 dark:text-zinc-400 bg-zinc-200 dark:bg-zinc-800 px-2 py-0.5 rounded">
                {fileType || 'Text'}
              </span>
            </div>
            
            {/* Streaming state */}
            <div className="flex-1 flex items-center justify-center p-8 bg-white dark:bg-zinc-950">
              <div className="text-center">
                <CircleDashed className="h-8 w-8 mx-auto mb-3 text-blue-500 animate-spin" />
                <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
                  {operation === "create" ? "Creating file..." : "Rewriting file..."}
                </p>
                <p className="text-xs mt-1 text-zinc-500 dark:text-zinc-400">
                  {processedFilePath || "Processing file operation"}
                </p>
              </div>
            </div>
          </div>
        )}
        
        {/* Delete view with file path */}
        {operation === "delete" && processedFilePath && !isStreaming && (
          <div className="border border-zinc-200 dark:border-zinc-800 rounded-md overflow-hidden h-full flex flex-col">
            <div className="p-6 flex-1 flex flex-col items-center justify-center bg-white dark:bg-zinc-950 text-zinc-900 dark:text-zinc-100">
              <div className="w-14 h-14 rounded-full bg-red-50 dark:bg-red-900/20 flex items-center justify-center mb-4">
                <FileX className="h-7 w-7 text-red-600 dark:text-red-400" />
              </div>
              <h3 className="text-lg font-medium mb-4 text-red-600 dark:text-red-400">File Deleted</h3>
              <div className="bg-zinc-50 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-md p-4 w-full max-w-md text-center mb-2">
                <code className="text-sm font-mono text-zinc-700 dark:text-zinc-300 break-all">{processedFilePath}</code>
              </div>
              <p className="text-sm text-zinc-500 dark:text-zinc-400 mt-2">This file has been permanently removed</p>
            </div>
          </div>
        )}
        
        {/* Delete view streaming state */}
        {operation === "delete" && isStreaming && (
          <div className="border border-zinc-200 dark:border-zinc-800 rounded-md overflow-hidden h-full flex flex-col">
            <div className="p-6 flex-1 flex flex-col items-center justify-center bg-white dark:bg-zinc-950">
              <div className="text-center">
                <CircleDashed className="h-8 w-8 mx-auto mb-3 text-blue-500 animate-spin" />
                <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300">Deleting file...</p>
                {processedFilePath && (
                  <p className="text-xs mt-2 font-mono text-zinc-500 dark:text-zinc-400 break-all">
                    {processedFilePath}
                  </p>
                )}
              </div>
            </div>
          </div>
        )}
        
        {/* Delete view with unknown path */}
        {operation === "delete" && !processedFilePath && !showDebugInfo && !isStreaming && (
          <div className="border border-zinc-200 dark:border-zinc-800 rounded-md overflow-hidden h-full flex flex-col">
            <div className="p-6 flex-1 flex flex-col items-center justify-center bg-white dark:bg-zinc-950 text-zinc-900 dark:text-zinc-100">
              <div className="w-14 h-14 rounded-full bg-red-50 dark:bg-red-900/20 flex items-center justify-center mb-4">
                <FileX className="h-7 w-7 text-red-600 dark:text-red-400" />
              </div>
              <h3 className="text-lg font-medium mb-4 text-red-600 dark:text-red-400">File Deleted</h3>
              <div className="bg-zinc-50 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-md p-4 w-full max-w-md text-center mb-2">
                <p className="text-sm text-zinc-700 dark:text-zinc-300">Unknown file path</p>
              </div>
              <p className="text-sm text-zinc-500 dark:text-zinc-400 mt-2">A file has been deleted but the path could not be determined</p>
            </div>
          </div>
        )}
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
                {isSuccess ? config.successMessage : `Failed to ${operation} file`}
              </span>
            </div>
          )}
          
          {isStreaming && (
            <div className="flex items-center gap-2">
              <CircleDashed className="h-3.5 w-3.5 text-blue-500 animate-spin" />
              <span>Processing file operation...</span>
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