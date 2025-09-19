'use client';

import React, { useState, useCallback } from 'react';
import {
  FileText,
  CheckCircle,
  AlertTriangle,
  Pen,
  Download,
  ChevronDown,
} from 'lucide-react';
import { ToolViewProps } from '../types';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { LoadingState } from '../shared/LoadingState';
import { cn } from '@/lib/utils';
import { FileViewerModal } from '@/components/thread/file-viewer-modal';
import { TipTapDocumentModal } from '@/components/thread/tiptap-document-modal';
import { exportDocument, type ExportFormat } from '@/lib/utils/document-export';
import { 
  DocumentInfo, 
  extractDocsData, 
  extractToolName, 
  extractParametersFromAssistant,
  getActionTitle,
  LiveDocumentViewer,
  DocumentViewer
} from './_utils';

export function DocsToolView({
  name = 'docs',
  assistantContent,
  toolContent,
  assistantTimestamp,
  toolTimestamp,
  isSuccess = true,
  isStreaming = false,
  project,
}: ToolViewProps) {
  const [fileViewerOpen, setFileViewerOpen] = useState(false);
  const [selectedDocPath, setSelectedDocPath] = useState<string | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorDocumentData, setEditorDocumentData] = useState<any>(null);
  const [editorFilePath, setEditorFilePath] = useState<string | null>(null);
  
  const toolName = extractToolName(toolContent) || name || 'docs';
  const data = extractDocsData(toolContent);

  const handleExport = useCallback(async (format: ExportFormat) => {
    const content = data?.content || data?.document?.content || '';
    const fileName = data?.document?.title || 'document';

    await exportDocument({ content, fileName, format });
  }, [data]);
  
  const assistantParams = extractParametersFromAssistant(assistantContent);
  
  if (data && assistantParams && (toolName.includes('create') || toolName.includes('update'))) {
    if (!data.content && assistantParams.content) {
      data.content = assistantParams.content;
    }
    if (data.document && !data.document.content && assistantParams.content) {
      data.document.content = assistantParams.content;
    }
  }

  if (isStreaming || !data) {
    return <LoadingState title="Processing Document..." />;
  }
  
  const getStatusIcon = () => {
    if (!data || !data.success || data.error) {
      return <AlertTriangle className="w-2 h-2 text-rose-500" />;
    }
    return <CheckCircle className="w-2 h-2 text-emerald-500" />;
  };
  
  const handleOpenInEditor = (doc: DocumentInfo, content?: string) => {
    let actualContent = content || doc.content || '';
    if (actualContent === '<p></p>' || actualContent === '<p><br></p>' || actualContent.trim() === '') {
      if (data && data.content) {
        actualContent = data.content;
      }
    }
    
    const documentData = {
      type: 'tiptap_document',
      version: '1.0',
      title: doc.title,
      content: actualContent,
      metadata: doc.metadata || {},
      created_at: doc.created_at,
      updated_at: doc.updated_at,
      doc_id: doc.id
    };
    
    setEditorDocumentData(documentData);
    setEditorFilePath(doc.path);
    setEditorOpen(true);
  };
  
  return (
    <>
    <Card className="gap-0 flex border shadow-none border-t border-b-0 border-x-0 p-0 rounded-none flex-col h-full overflow-hidden bg-card">
      <CardHeader className="h-14 bg-zinc-50/80 dark:bg-zinc-900/80 backdrop-blur-sm border-b p-2 px-4 space-y-2">
        <div className="flex flex-row items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="relative p-2 rounded-xl bg-gradient-to-br from-blue-500/20 to-purple-600/10 border border-blue-500/20">
              <FileText className="w-5 h-5 text-blue-500 dark:text-blue-400" />
            </div>
            <div>
              <CardTitle className="text-base font-medium text-zinc-900 dark:text-zinc-100">
                {getActionTitle(toolName)}
              </CardTitle>
            </div>
          </div>
          
          <div className="flex items-center gap-2">
            {data.document?.format === 'doc' && (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    let content = data.document.content || '';
                    if (typeof content === 'string' && content.includes('"type":"tiptap_document"')) {
                      try {
                        const parsed = JSON.parse(content);
                        if (parsed.type === 'tiptap_document' && parsed.content) {
                          content = parsed.content;
                        }
                      } catch {}
                    }
                    handleOpenInEditor(data.document, content);
                  }}
                >
                  <Pen className="h-3 w-3" />
                  Edit
                </Button>
                
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button size="sm" variant="outline">
                      <Download className="h-3 w-3" />
                      Export
                      <ChevronDown className="h-3 w-3" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onClick={() => handleExport('docx')}>
                      Export as DOCX
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => handleExport('txt')}>
                      Export as Text
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </>
            )}
            <Badge
              variant="secondary"
              className={cn(
                data && data.success && !data.error
                  ? "bg-gradient-to-b from-emerald-200 to-emerald-100 text-emerald-700 dark:from-emerald-800/50 dark:to-emerald-900/60 dark:text-emerald-300"
                  : "bg-gradient-to-b from-rose-200 to-rose-100 text-rose-700 dark:from-rose-800/50 dark:to-rose-900/60 dark:text-rose-300"
              )}
            >
              {getStatusIcon()}
              {data && data.success && !data.error ? 'Success' : 'Failed'}
            </Badge>
          </div>
        </div>
      </CardHeader>
      
      <CardContent className="flex-1 px-0 overflow-hidden flex flex-col">
        {data.error ? (
          <div className="space-y-4 p-4">
            <div className="flex items-center gap-2 p-4 bg-rose-50 dark:bg-rose-900/20 rounded-lg">
              <AlertTriangle className="h-5 w-5 text-rose-500" />
              <span className="text-sm text-rose-700 dark:text-rose-300">
                {data.error}
              </span>
            </div>
            {process.env.NODE_ENV === 'development' && toolContent && (
              <details className="text-xs">
                <summary className="cursor-pointer text-muted-foreground">Debug: Raw Response</summary>
                <pre className="mt-2 p-2 bg-muted rounded text-xs overflow-auto">
                  {JSON.stringify(toolContent, null, 2)}
                </pre>
              </details>
            )}
          </div>
        ) : (
          <div className="flex-1 flex flex-col min-h-0">
            {data.document && !data.documents && (
              <div className="flex-1 min-h-0">
                {(data.document.path || data.content || data.document.content) && (
                  <div className="h-full overflow-y-auto p-4 scrollbar-thin scrollbar-thumb-zinc-200 dark:scrollbar-thumb-zinc-800 scrollbar-track-transparent">
                    {data.document.path && data.sandbox_id ? (
                      <LiveDocumentViewer 
                        path={data.document.path}
                        sandboxId={data.sandbox_id}
                        format={data.document.format || 'doc'}
                        fallbackContent={data.content || data.document.content || ''}
                      />
                    ) : (
                      <DocumentViewer 
                        content={data.content || data.document.content || ''} 
                        format={data.document.format || 'doc'} 
                      />
                    )}
                  </div>
                )}
              </div>
            )}
            {data.documents && data.documents.length === 0 && (
              <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
                <FileText className="h-12 w-12 mb-4 opacity-50" />
                <p className="text-sm">No documents found</p>
              </div>
            )}
            {data.message && !data.document && !data.documents && (
              <div className="flex items-center gap-2 p-4 bg-emerald-50 dark:bg-emerald-900/20 rounded-lg mx-4">
                <CheckCircle className="h-5 w-5 text-emerald-500" />
                <span className="text-sm text-emerald-700 dark:text-emerald-300">
                  {data.message}
                </span>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
    {(data?.sandbox_id || project?.id) && selectedDocPath && (
      <FileViewerModal
        open={fileViewerOpen}
        onOpenChange={setFileViewerOpen}
        sandboxId={data?.sandbox_id || project?.id || ''}
        initialFilePath={selectedDocPath}
        project={project}
      />
    )}
    {editorFilePath && editorDocumentData && (
      <TipTapDocumentModal
        open={editorOpen}
        onOpenChange={setEditorOpen}
        filePath={editorFilePath}
        documentData={editorDocumentData}
        sandboxId={data?.sandbox_id || project?.id || ''}
      />
    )}
    </>
  );
} 