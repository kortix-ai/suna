'use client'

import React from 'react';
import {
  Database,
  Search,
  FolderPlus,
  Upload,
  List,
  Trash2,
  Download,
  Eye,
  EyeOff,
  Copy,
  Check
} from 'lucide-react';
import { ToolViewProps } from './types';
import { formatTimestamp, getToolTitle, extractToolData } from './utils';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from '@/components/ui/button';
import { LoadingState } from './shared/LoadingState';
import { toast } from 'sonner';

interface KbOperation {
  type: 'search' | 'sync' | 'list' | 'create' | 'upload' | 'delete' | 'enable' | 'cleanup' | 'init';
  scope: 'local' | 'global';
  data?: any;
}

const getKbIcon = (operation: KbOperation) => {
  switch (operation.type) {
    case 'search': return Search;
    case 'sync': return Download;
    case 'list': return List;
    case 'create': return FolderPlus;
    case 'upload': return Upload;
    case 'delete': return Trash2;
    case 'enable': return operation.data?.enabled ? Eye : EyeOff;
    case 'init':
    case 'cleanup':
    default: return Database;
  }
};

const parseKbTool = (name: string, content: string): KbOperation | null => {
  if (!content) return null;

  const parsed = extractToolData(content);
  const functionName = parsed.toolResult?.functionName || name;

  // Determine operation type and scope
  if (functionName.includes('global_kb') || functionName.includes('global-kb')) {
    const type = functionName.includes('sync') ? 'sync' :
      functionName.includes('create') ? 'create' :
        functionName.includes('upload') ? 'upload' :
          functionName.includes('delete') ? 'delete' :
            functionName.includes('enable') ? 'enable' :
              functionName.includes('list') ? 'list' : 'sync';

    return {
      type,
      scope: 'global',
      data: parsed.toolResult?.arguments || {}
    };
  }

  if (functionName.includes('search_files')) {
    return {
      type: 'search',
      scope: 'local',
      data: parsed.toolResult?.arguments || {}
    };
  }

  if (functionName.includes('init_kb')) {
    return {
      type: 'init',
      scope: 'local',
      data: parsed.toolResult?.arguments || {}
    };
  }

  if (functionName.includes('cleanup_kb')) {
    return {
      type: 'cleanup',
      scope: 'local',
      data: parsed.toolResult?.arguments || {}
    };
  }

  if (functionName.includes('ls_kb')) {
    return {
      type: 'list',
      scope: 'local',
      data: parsed.toolResult?.arguments || {}
    };
  }

  return null;
};

const KbResultDisplay: React.FC<{ operation: KbOperation; toolOutput: any }> = ({
  operation,
  toolOutput
}) => {
  if (!toolOutput) return null;

  const output = typeof toolOutput === 'string' ? toolOutput : JSON.stringify(toolOutput, null, 2);

  // For init and sync operations, try to extract version info
  if (operation.type === 'init' || operation.type === 'sync') {
    let parsedOutput;
    try {
      parsedOutput = JSON.parse(output);
    } catch {
      parsedOutput = null;
    }

    const version = parsedOutput?.version || output.match(/version[:\s]*([0-9.]+)/i)?.[1] || output.match(/v([0-9.]+)/)?.[1];
    const message = parsedOutput?.message || output.match(/(installed|updated|synced|ready)[^.]*\.?/i)?.[0];
    const syncedFiles = parsedOutput?.synced_files;
    const folderStructure = parsedOutput?.folder_structure;
    const kbDirectory = parsedOutput?.kb_directory;

    return (
      <div className="space-y-3">
        <div className="space-y-2">
          {version && (
            <div className="flex items-center justify-between text-sm">
              <span className="font-medium text-zinc-700 dark:text-zinc-300">KB Version</span>
              <span className="text-zinc-900 dark:text-zinc-100 font-mono">{version}</span>
            </div>
          )}
          {message && (
            <div className="text-sm text-green-600 dark:text-green-400 bg-green-50 dark:bg-green-950/20 rounded p-3">
              {message}
            </div>
          )}
          {kbDirectory && (
            <div className="flex items-center justify-between text-sm">
              <span className="font-medium text-zinc-700 dark:text-zinc-300">KB Directory</span>
              <span className="text-zinc-900 dark:text-zinc-100 font-mono">{kbDirectory}</span>
            </div>
          )}
          {syncedFiles && (
            <div className="space-y-2">
              <div className="flex items-center justify-between text-sm">
                <span className="font-medium text-zinc-700 dark:text-zinc-300">Synced Files</span>
                <span className="text-zinc-900 dark:text-zinc-100">{syncedFiles}</span>
              </div>
              {folderStructure && (
                <div className="space-y-1">
                  {Object.entries(folderStructure).map(([folder, files]: [string, any]) => (
                    <div key={folder} className="text-sm bg-zinc-50 dark:bg-zinc-900 rounded p-2">
                      <span className="font-medium text-zinc-900 dark:text-zinc-100">{folder}</span>
                      <div className="text-xs text-zinc-600 dark:text-zinc-400 mt-1 space-y-1">
                        {Array.isArray(files) ? files.map((file, idx) => (
                          <div key={idx} className="flex items-center gap-1">
                            <span>•</span>
                            <span>{file}</span>
                          </div>
                        )) : `${files.length || 0} files`}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    );
  }

  // Handle search results with better formatting
  if (operation.type === 'search') {
    let parsedOutput;
    try {
      parsedOutput = JSON.parse(output);
    } catch {
      parsedOutput = null;
    }

    // Parse search results from nested JSON
    let searchData = null;
    if (parsedOutput?.search_results) {
      try {
        searchData = JSON.parse(parsedOutput.search_results);
      } catch {
        searchData = null;
      }
    }

    // Show query at top
    const queries = operation.data?.queries || [];

    if (searchData && Array.isArray(searchData)) {
      const totalHits = searchData.reduce((acc, result) => acc + (result.hits?.length || 0), 0);

      return (
        <div className="space-y-3">
          {queries.length > 0 && (
            <div className="text-sm">
              <span className="font-medium text-zinc-700 dark:text-zinc-300">Query: </span>
              <span className="text-zinc-900 dark:text-zinc-100">{queries.join(', ')}</span>
            </div>
          )}

          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">Search Results</span>
            <span className="text-xs text-zinc-500">{totalHits} matches</span>
          </div>

          <div className="space-y-2">
            {(() => {
              let globalMatchNumber = 1;
              return searchData.map((queryResult: any, qIdx: number) =>
                queryResult.hits?.slice(0, 5).map((hit: any, idx: number) => (
                  <div key={`${qIdx}-${idx}`} className="bg-zinc-50 dark:bg-zinc-900 rounded p-3 text-sm">
                    <div className="text-xs text-zinc-500 dark:text-zinc-400 mb-1">
                      {globalMatchNumber++}
                    </div>
                    <div className="text-zinc-600 dark:text-zinc-400 text-xs leading-relaxed">
                      {hit.snippet}
                    </div>
                  </div>
                ))
              );
            })()}
          </div>

          {operation.data?.path && (
            <div className="text-xs text-zinc-500 dark:text-zinc-400 mt-2">
              File: {operation.data.path.split('/').pop()}
            </div>
          )}
        </div>
      );
    }

    // Fallback for non-JSON or failed searches
    return (
      <div className="space-y-2">
        {queries.length > 0 && (
          <div className="text-sm">
            <span className="font-medium text-zinc-700 dark:text-zinc-300">Query: </span>
            <span className="text-zinc-900 dark:text-zinc-100">{queries.join(', ')}</span>
          </div>
        )}
        <div className="text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/20 rounded p-3">
          {output}
        </div>
        {operation.data?.path && (
          <div className="text-xs text-zinc-500 dark:text-zinc-400">
            File: {operation.data.path.split('/').pop()}
          </div>
        )}
      </div>
    );
  }

  // Handle list operations with count info
  if (operation.type === 'list') {
    let parsedOutput;
    try {
      parsedOutput = JSON.parse(output);
    } catch {
      parsedOutput = null;
    }

    // For global KB list
    if (operation.scope === 'global' && parsedOutput?.structure) {
      const totalFolders = parsedOutput.total_folders || 0;
      const totalFiles = parsedOutput.total_files || 0;
      const totalSize = parsedOutput.total_size_mb || 0;

      return (
        <div className="space-y-3">
          <div className="grid grid-cols-3 gap-4 text-sm">
            <div className="text-center p-2 bg-zinc-50 dark:bg-zinc-900 rounded">
              <div className="font-medium text-zinc-900 dark:text-zinc-100">{totalFolders}</div>
              <div className="text-xs text-zinc-500">Folders</div>
            </div>
            <div className="text-center p-2 bg-zinc-50 dark:bg-zinc-900 rounded">
              <div className="font-medium text-zinc-900 dark:text-zinc-100">{totalFiles}</div>
              <div className="text-xs text-zinc-500">Files</div>
            </div>
            <div className="text-center p-2 bg-zinc-50 dark:bg-zinc-900 rounded">
              <div className="font-medium text-zinc-900 dark:text-zinc-100">{totalSize.toFixed(2)} MB</div>
              <div className="text-xs text-zinc-500">Size</div>
            </div>
          </div>

          <div className="space-y-2">
            {Object.entries(parsedOutput.structure).slice(0, 3).map(([folderName, folderData]: [string, any]) => (
              <div key={folderName} className="bg-zinc-50 dark:bg-zinc-900 rounded p-3">
                <div className="font-medium text-zinc-900 dark:text-zinc-100 text-sm mb-1">
                  {folderName}
                </div>
                <div className="text-xs text-zinc-600 dark:text-zinc-400 mb-2">
                  {folderData.description}
                </div>
                <div className="text-xs text-zinc-500">
                  {folderData.files?.length || 0} files
                </div>
              </div>
            ))}
            {Object.keys(parsedOutput.structure).length > 3 && (
              <div className="text-xs text-zinc-500 text-center">
                +{Object.keys(parsedOutput.structure).length - 3} more folders
              </div>
            )}
          </div>
        </div>
      );
    }

    // For local KB list  
    if (operation.scope === 'local' && parsedOutput?.output) {
      const lines = parsedOutput.output.split('\n').filter((line: string) => line.trim());
      const files = lines.map((line: string) => {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 4) {
          const status = parts[0];
          const size = parseInt(parts[1]);
          const date = parts[2];
          const path = parts.slice(4).join(' ');
          const filename = path.split('/').pop() || path;
          return { status, size, date, path, filename };
        }
        return null;
      }).filter(Boolean);

      return (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">Indexed Files</span>
            <span className="text-xs text-zinc-500">{files.length} files</span>
          </div>

          <div className="space-y-2">
            {files.slice(0, 5).map((file: any, idx: number) => (
              <div key={idx} className="bg-zinc-50 dark:bg-zinc-900 rounded p-3 text-sm">
                <div className="font-medium text-zinc-900 dark:text-zinc-100 mb-1">
                  {file.filename}
                </div>
                <div className="flex justify-between text-xs text-zinc-600 dark:text-zinc-400">
                  <span>{(file.size / 1024).toFixed(1)} KB</span>
                  <span>{file.date}</span>
                  <span className={file.status === 'active' ? 'text-green-600' : 'text-zinc-500'}>
                    {file.status}
                  </span>
                </div>
              </div>
            ))}
            {files.length > 5 && (
              <div className="text-xs text-zinc-500 text-center">
                +{files.length - 5} more files
              </div>
            )}
          </div>
        </div>
      );
    }

    // Fallback for unknown format
    const lineCount = output.split('\n').filter(line => line.trim()).length;
    return (
      <div className="space-y-2">
        <div className="text-sm font-medium text-zinc-700 dark:text-zinc-300 flex items-center justify-between">
          <span>{operation.scope === 'global' ? 'Global KB Contents' : 'Local Files'}</span>
          <span className="text-xs text-zinc-500">{lineCount} items</span>
        </div>
        <div className="bg-zinc-50 dark:bg-zinc-900 rounded-lg p-3">
          <pre className="text-xs text-zinc-600 dark:text-zinc-400 whitespace-pre-wrap">
            {output}
          </pre>
        </div>
      </div>
    );
  }

  // Generic output for other operations - avoid raw JSON
  let parsedOutput;
  try {
    parsedOutput = JSON.parse(output);
  } catch {
    parsedOutput = null;
  }

  // Extract key info from JSON responses
  if (parsedOutput) {
    const message = parsedOutput.message;
    const success = parsedOutput.success !== false;
    const items = parsedOutput.items || parsedOutput.files || parsedOutput.folders;
    const count = parsedOutput.count || (Array.isArray(items) ? items.length : null);

    // Special handling for create folder
    if (operation.type === 'create') {
      return (
        <div className="space-y-2">
          {message && (
            <div className={`text-sm p-3 rounded ${success
              ? 'text-green-600 dark:text-green-400 bg-green-50 dark:bg-green-950/20'
              : 'text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/20'
              }`}>
              {message}
            </div>
          )}
        </div>
      );
    }

    // Special handling for upload file 
    if (operation.type === 'upload') {
      return (
        <div className="space-y-2">
          {message && (
            <div className={`text-sm p-3 rounded ${success
              ? 'text-green-600 dark:text-green-400 bg-green-50 dark:bg-green-950/20'
              : 'text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/20'
              }`}>
              {message}
            </div>
          )}
        </div>
      );
    }

    // Special handling for cleanup
    if (operation.type === 'cleanup') {
      return (
        <div className="space-y-2">
          {message && (
            <div className={`text-sm p-3 rounded ${success
              ? 'text-green-600 dark:text-green-400 bg-green-50 dark:bg-green-950/20'
              : 'text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/20'
              }`}>
              {message}
            </div>
          )}
        </div>
      );
    }

    // Special handling for enable/toggle
    if (operation.type === 'enable') {
      return (
        <div className="space-y-2">
          {message && (
            <div className={`text-sm p-3 rounded ${success
              ? 'text-green-600 dark:text-green-400 bg-green-50 dark:bg-green-950/20'
              : 'text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/20'
              }`}>
              {message}
            </div>
          )}
        </div>
      );
    }

    // Special handling for delete
    if (operation.type === 'delete') {
      return (
        <div className="space-y-2">
          {message && (
            <div className={`text-sm p-3 rounded ${success
              ? 'text-green-600 dark:text-green-400 bg-green-50 dark:bg-green-950/20'
              : 'text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/20'
              }`}>
              {message}
            </div>
          )}
        </div>
      );
    }

    return (
      <div className="space-y-3">
        {message && (
          <div className={`text-sm p-3 rounded ${success
            ? 'text-green-600 dark:text-green-400 bg-green-50 dark:bg-green-950/20'
            : 'text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/20'
            }`}>
            {message}
          </div>
        )}
        {count !== null && (
          <div className="flex items-center justify-between text-sm">
            <span className="font-medium text-zinc-700 dark:text-zinc-300">Items</span>
            <span className="text-zinc-900 dark:text-zinc-100">{count}</span>
          </div>
        )}
        {items && Array.isArray(items) && (
          <div className="space-y-1">
            {items.slice(0, 3).map((item: any, idx: number) => (
              <div key={idx} className="text-xs text-zinc-600 dark:text-zinc-400 bg-zinc-50 dark:bg-zinc-900 rounded p-2">
                {typeof item === 'string' ? item : item.name || item.path || JSON.stringify(item)}
              </div>
            ))}
            {items.length > 3 && (
              <div className="text-xs text-zinc-500 text-center">
                +{items.length - 3} more items
              </div>
            )}
          </div>
        )}
      </div>
    );
  }

  // Fallback to raw output only if no JSON structure
  return (
    <div className="space-y-2">
      <div className={`text-sm p-3 rounded ${output.toLowerCase().includes('error') || output.toLowerCase().includes('failed') || output.toLowerCase().includes('not found')
          ? 'text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/20'
          : 'text-zinc-600 dark:text-zinc-400 bg-zinc-50 dark:bg-zinc-900'
        }`}>
        {output}
      </div>
    </div>
  );
};

const KbParametersDisplay: React.FC<{ operation: KbOperation }> = ({ operation }) => {
  if (!operation.data || Object.keys(operation.data).length === 0) return null;

  // Skip parameters for most operations to reduce redundancy - the result tells the story
  if (['create', 'upload', 'search', 'init', 'cleanup', 'enable', 'delete'].includes(operation.type)) {
    return null;
  }

  return (
    <div className="space-y-2">
      <div className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
        Parameters
      </div>
      <div className="bg-blue-50 dark:bg-blue-950/20 border border-blue-200 dark:border-blue-900 rounded-lg p-3">
        <div className="space-y-1 text-xs">
          {Object.entries(operation.data).map(([key, value]) => (
            <div key={key} className="flex">
              <span className="font-medium text-blue-700 dark:text-blue-300 min-w-20">
                {key}:
              </span>
              <span className="ml-2 text-blue-600 dark:text-blue-400">
                {Array.isArray(value) ? value.join(', ') : String(value)}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

export function KbToolView({
  name = 'kb-tool',
  assistantContent,
  toolContent,
  assistantTimestamp,
  toolTimestamp,
  isSuccess = true,
  isStreaming = false,
}: ToolViewProps) {
  const [copied, setCopied] = React.useState(false);

  const operation = parseKbTool(name, assistantContent || toolContent || '');
  const { toolResult } = extractToolData(assistantContent || toolContent || '');

  if (!operation) {
    return null; // Fallback to generic tool view
  }

  const Icon = getKbIcon(operation);
  const isGlobal = operation.scope === 'global';
  const scopeLabel = isGlobal ? 'Global KB' : 'Local KB';

  const copyContent = () => {
    const content = toolResult?.toolOutput || 'No output';
    navigator.clipboard.writeText(content);
    setCopied(true);
    toast.success('Output copied to clipboard');
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <Card className="gap-0 flex border shadow-none border-t border-b-0 border-x-0 p-0 rounded-none flex-col h-full overflow-hidden bg-card">
      <CardHeader className="h-14 bg-zinc-50/80 dark:bg-zinc-900/80 backdrop-blur-sm border-b p-2 px-4 space-y-2">
        <div className="flex flex-row items-center justify-between">
          <div className="flex items-center gap-2">
            <div className={isGlobal
              ? "relative p-2 rounded-lg bg-gradient-to-br from-blue-500/20 to-blue-600/10 border border-blue-500/20"
              : "relative p-2 rounded-lg bg-gradient-to-br from-green-500/20 to-green-600/10 border border-green-500/20"
            }>
              <Icon className={isGlobal
                ? "w-5 h-5 text-blue-500 dark:text-blue-400"
                : "w-5 h-5 text-green-500 dark:text-green-400"
              } />
            </div>
            <div>
              <CardTitle className="text-base font-medium text-zinc-900 dark:text-zinc-100">
                {operation.type === 'init' ? 'Initialize KB' :
                  operation.type === 'search' ? 'Search Files' :
                    operation.type === 'sync' ? 'Sync KB' :
                      operation.type === 'list' ? 'List Contents' :
                        operation.type === 'create' ? 'Create Folder' :
                          operation.type === 'upload' ? 'Upload File' :
                            operation.type === 'delete' ? 'Delete Item' :
                              operation.type === 'enable' ? 'Toggle Item' :
                                operation.type === 'cleanup' ? 'Cleanup KB' :
                                  (operation.type as string).charAt(0).toUpperCase() + (operation.type as string).slice(1)
                } • {scopeLabel}
              </CardTitle>
            </div>
          </div>

          {!isStreaming && (
            <div className="flex items-center gap-2">
              <Badge
                variant="secondary"
                className={
                  isSuccess
                    ? "bg-gradient-to-b from-emerald-200 to-emerald-100 text-emerald-700 dark:from-emerald-800/50 dark:to-emerald-900/60 dark:text-emerald-300"
                    : "bg-gradient-to-b from-rose-200 to-rose-100 text-rose-700 dark:from-rose-800/50 dark:to-rose-900/60 dark:text-rose-300"
                }
              >
                {isSuccess ? 'Success' : 'Failed'}
              </Badge>
              {toolResult?.toolOutput && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={copyContent}
                  className="h-7 px-2"
                >
                  {copied ? (
                    <Check className="h-3.5 w-3.5" />
                  ) : (
                    <Copy className="h-3.5 w-3.5" />
                  )}
                </Button>
              )}
            </div>
          )}
        </div>
      </CardHeader>

      <CardContent className="p-0 flex-1 overflow-hidden relative">
        {isStreaming ? (
          <LoadingState
            iconColor={isGlobal
              ? "text-blue-500 dark:text-blue-400"
              : "text-green-500 dark:text-green-400"
            }
            bgColor={isGlobal
              ? "bg-gradient-to-b from-blue-100 to-blue-50 shadow-inner dark:from-blue-800/40 dark:to-blue-900/60"
              : "bg-gradient-to-b from-green-100 to-green-50 shadow-inner dark:from-green-800/40 dark:to-green-900/60"
            }
            title={`${operation.type} ${scopeLabel}`}
            filePath={`${operation.scope}/${operation.type}`}
            showProgress={true}
          />
        ) : (
          <ScrollArea className="h-full w-full">
            <div className="p-4 space-y-6">
              <KbParametersDisplay operation={operation} />
              <KbResultDisplay operation={operation} toolOutput={toolResult?.toolOutput} />
            </div>
          </ScrollArea>
        )}
      </CardContent>

      <div className="px-4 py-2 h-10 bg-gradient-to-r from-zinc-50/90 to-zinc-100/90 dark:from-zinc-900/90 dark:to-zinc-800/90 backdrop-blur-sm border-t border-zinc-200 dark:border-zinc-800 flex justify-between items-center">
        <div className="flex items-center gap-2 text-sm text-zinc-500 dark:text-zinc-400">
          <Badge variant="outline" className="h-6 py-0.5 bg-zinc-50 dark:bg-zinc-900">
            <Database className="h-3 w-3" />
            KB Tool
          </Badge>
        </div>
        <div className="text-xs text-zinc-500 dark:text-zinc-400">
          {toolTimestamp && !isStreaming
            ? formatTimestamp(toolTimestamp)
            : assistantTimestamp
              ? formatTimestamp(assistantTimestamp)
              : ''}
        </div>
      </div>
    </Card>
  );
}