import React, { useState } from "react";
import { FileCode, FileSymlink, FolderPlus, FileX, Replace, CheckCircle, AlertTriangle, ExternalLink, CircleDashed, Code, Eye, FileSpreadsheet } from "lucide-react";
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark, oneLight } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { ToolViewProps } from "./types";
import { extractFilePath, extractFileContent, getFileType, formatTimestamp, getToolTitle } from "./utils";
import { GenericToolView } from "./GenericToolView";
import { MarkdownRenderer, processUnicodeContent } from "@/components/file-renderers/markdown-renderer";
import { CsvRenderer } from "@/components/file-renderers/csv-renderer";
import { cn } from "@/lib/utils";
import { useTheme } from "next-themes";

// Type for operation type
type FileOperation = "create" | "rewrite" | "delete";

// Map file extensions to language names for syntax highlighting
const getLanguageFromFileName = (fileName: string): string => {
  const extension = fileName.split('.').pop()?.toLowerCase() || '';
  
  // Map of file extensions to language names for syntax highlighting
  const extensionMap: Record<string, string> = {
    // Web languages
    'html': 'html',
    'htm': 'html',
    'css': 'css',
    'scss': 'scss',
    'sass': 'scss',
    'less': 'less',
    'js': 'javascript',
    'jsx': 'jsx',
    'ts': 'typescript',
    'tsx': 'tsx',
    'json': 'json',
    'jsonc': 'json',
    
    // Build and config files
    'xml': 'xml',
    'yml': 'yaml',
    'yaml': 'yaml',
    'toml': 'toml',
    'ini': 'ini',
    'env': 'bash',
    'gitignore': 'bash',
    'dockerignore': 'bash',
    
    // Scripting languages
    'py': 'python',
    'rb': 'ruby',
    'php': 'php',
    'go': 'go',
    'java': 'java',
    'kt': 'kotlin',
    'c': 'c',
    'cpp': 'cpp',
    'h': 'c',
    'hpp': 'cpp',
    'cs': 'csharp',
    'swift': 'swift',
    'rs': 'rust',
    
    // Shell scripts
    'sh': 'bash',
    'bash': 'bash',
    'zsh': 'bash',
    'ps1': 'powershell',
    'bat': 'batch',
    'cmd': 'batch',
    
    // Markup languages (excluding markdown which has its own renderer)
    'svg': 'svg',
    'tex': 'latex',
    
    // Data formats
    'graphql': 'graphql',
    'gql': 'graphql',
  };
  
  return extensionMap[extension] || 'text';
};

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
  const { resolvedTheme } = useTheme();
  const isDarkTheme = resolvedTheme === 'dark';
  
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
  
  // Process file path - handle potential newlines and clean up
  const processedFilePath = filePath ? filePath.trim().replace(/\\n/g, '\n').split('\n')[0] : null;
  
  // For create and rewrite, prepare content for display
  const contentLines = fileContent ? fileContent.replace(/\\n/g, '\n').split('\n') : [];
  const fileName = processedFilePath ? processedFilePath.split('/').pop() || processedFilePath : '';
  const fileType = processedFilePath ? getFileType(processedFilePath) : '';
  const isMarkdown = fileName.endsWith('.md');
  const isHtml = fileName.endsWith('.html');
  const isCsv = fileName.endsWith('.csv');
  const language = getLanguageFromFileName(fileName);
  const hasHighlighting = language !== 'text';
  // Construct HTML file preview URL if we have a sandbox and the file is HTML
  const htmlPreviewUrl = (isHtml && project?.sandbox?.sandbox_url && processedFilePath) 
    ? `${project.sandbox.sandbox_url}/${encodeURIComponent(processedFilePath)}`
    : undefined;
    
  console.log('HTML Preview URL:', htmlPreviewUrl);
  // Add state for view mode toggle (code or preview)
  const [viewMode, setViewMode] = useState<'code' | 'preview'>(isHtml || isMarkdown || isCsv ? 'preview' : 'code');
  
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
  const Icon = config.icon;
  
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
                  isCsv ?
                  <FileSpreadsheet className="h-4 w-4 mr-2 text-zinc-600 dark:text-zinc-400" /> :
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
                {/* View switcher for Markdown files */}
                {isMarkdown && isSuccess && (
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
                {/* View switcher for CSV files */}
                {isCsv && isSuccess && (
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
                  {hasHighlighting ? language.toUpperCase() : fileType}
                </span>
              </div>
            </div>
            
            {/* File Content (Code View with Syntax Highlighting) */}
            {viewMode === 'code' || (!isHtml && !isMarkdown && !isCsv) || !isSuccess ? (
              <div className="flex-1 overflow-auto bg-white dark:bg-zinc-950 text-zinc-900 dark:text-zinc-100">
                {hasHighlighting ? (
                  <div className="relative">
                    <div className="absolute left-0 top-0 bottom-0 w-12 border-r border-zinc-200 dark:border-zinc-800 z-10 flex flex-col">
                      {contentLines.map((_, idx) => (
                        <div key={idx} 
                          className="h-6 text-right pr-3 text-xs font-mono text-zinc-500 dark:text-zinc-500 select-none">
                          {idx + 1}
                        </div>
                      ))}
                    </div>
                    <div className="pl-12">
                      <SyntaxHighlighter
                        language={language}
                        style={isDarkTheme ? oneDark : oneLight}
                        customStyle={{
                          margin: 0,
                          padding: '0.5rem 1rem',
                          background: 'transparent',
                          fontSize: '0.75rem',
                          lineHeight: '1.5rem',
                          minHeight: '100%',
                          backgroundColor: 'transparent'
                        }}
                        codeTagProps={{
                          style: {
                            backgroundColor: 'transparent'
                          }
                        }}
                        useInlineStyles={true}
                        wrapLines={true}
                        lineProps={(lineNumber) => ({
                          style: {
                            display: 'block',
                            width: '100%',
                            backgroundColor: 'transparent',
                            lineHeight: '1.5rem',
                            minHeight: '1.5rem',
                            padding: '0 0.25rem',
                            ':hover': {
                              backgroundColor: isDarkTheme ? 'rgba(39, 39, 42, 0.5)' : 'rgba(244, 244, 245, 0.5)',
                            }
                          },
                          className: 'hover:bg-zinc-50 dark:hover:bg-zinc-900 transition-colors'
                        })}
                        showLineNumbers={false}
                      >
                        {processUnicodeContent(fileContent)}
                      </SyntaxHighlighter>
                    </div>
                  </div>
                ) : (
                  <div className="min-w-full table">
                    {contentLines.map((line, idx) => (
                      <div key={idx} className="table-row hover:bg-zinc-50 dark:hover:bg-zinc-900 transition-colors">
                        <div className="table-cell text-right pr-3 py-0.5 text-xs font-mono text-zinc-500 dark:text-zinc-500 select-none w-12 border-r border-zinc-200 dark:border-zinc-800">
                          {idx + 1}
                        </div>
                        <div className="table-cell pl-3 py-0.5 text-xs font-mono whitespace-pre text-zinc-800 dark:text-zinc-300">
                          {processUnicodeContent(line) || ' '}
                        </div>
                      </div>
                    ))}
                    <div className="table-row h-4"></div>
                  </div>
                )}
              </div>
            ) : null}
            
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
            
            {/* Markdown Preview */}
            {isMarkdown && viewMode === 'preview' && isSuccess && (
              <div className="flex-1 overflow-auto bg-white dark:bg-zinc-950 text-zinc-900 dark:text-zinc-100">
                <MarkdownRenderer content={processUnicodeContent(fileContent)} />
              </div>
            )}
            
            {/* CSV Preview */}
            {isCsv && viewMode === 'preview' && isSuccess && (
              <div className="flex-1 overflow-hidden bg-white dark:bg-zinc-950">
                <CsvRenderer content={processUnicodeContent(fileContent)} />
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