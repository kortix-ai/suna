'use client';

import React, { useState, useCallback } from 'react';
import {
  FileText,
  CheckCircle,
  AlertTriangle,
  Pen,
  Download,
  ChevronDown,
  Loader2,
  Share,
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
import { createClient } from '@/lib/supabase/client';
import { handleGoogleDocsUpload, checkPendingGoogleDocsUpload } from '@/lib/utils/google-docs-utils';
import { useEffect } from 'react';
import { 
  DocumentInfo, 
  extractDocsData, 
  extractToolName, 
  extractParametersFromAssistant,
  extractStreamingDocumentContent,
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
  const [isExporting, setIsExporting] = useState(false);
  
  // Check for pending Google Docs upload after OAuth callback
  useEffect(() => {
    checkPendingGoogleDocsUpload();
  }, []);
  
  const handleOpenInEditor = useCallback(async (doc: DocumentInfo, content?: string, data?: any) => {
    let actualContent = content || doc.content || '';
    if (data?.sandbox_id && doc.path) {
      try {
        const supabase = createClient();
        const { data: { session } } = await supabase.auth.getSession();
        
        if (session?.access_token) {
          const response = await fetch(
            `${process.env.NEXT_PUBLIC_BACKEND_URL}/sandboxes/${data.sandbox_id}/files?path=${encodeURIComponent(doc.path)}`,
            {
              headers: {
                'Authorization': `Bearer ${session.access_token}`,
              },
            }
          );

          if (response.ok) {
            const fileContent = await response.text();
            try {
              const parsedDocument = JSON.parse(fileContent);
              if (parsedDocument.type === 'tiptap_document' && parsedDocument.content) {
                actualContent = parsedDocument.content;
              }
            } catch {}
          }
        }
      } catch (error) {
        console.error('Failed to fetch latest content:', error);
      }
    }
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
      updated_at: doc.updated_at || new Date().toISOString(),
      doc_id: doc.id
    };
    
    setEditorDocumentData(documentData);
    setEditorFilePath(doc.path);
    setEditorOpen(true);
  }, []);
  
  const toolName = extractToolName(toolContent) || name || 'docs';
  let data = extractDocsData(toolContent);
  
  if (!data?.sandbox_id && project?.id) {
    data = { ...data, sandbox_id: project.id };
  }
  
  let streamingContent: { content?: string; title?: string; metadata?: any } | null = null;
  if (isStreaming && !data) {
    streamingContent = extractStreamingDocumentContent(assistantContent, toolName);
  }

  const handleExport = useCallback(async (format: ExportFormat | 'google-docs') => {
    if (format === 'google-docs') {
      if (!project?.sandbox?.sandbox_url || !data?.document?.path) {
        console.error('Missing sandbox URL or document path for Google Docs export');
        return;
      }
      
      setIsExporting(true);
      try {
        const result = await handleGoogleDocsUpload(
          project.sandbox.sandbox_url,
          data.document.path
        );
        if (result?.redirected_to_auth) {
          return;
        }
      } catch (error) {
        console.error('Error exporting to Google Docs:', error);
      } finally {
        setIsExporting(false);
      }
    } else {
      const content = data?.content || data?.document?.content || streamingContent?.content || '';
      const fileName = data?.document?.title || streamingContent?.title || 'document';

      await exportDocument({ content, fileName, format });
    }
  }, [data, streamingContent, project]);
  
  const assistantParams = extractParametersFromAssistant(assistantContent);
  
  if (data && assistantParams && (toolName.includes('create') || toolName.includes('update'))) {
    if (!data.content && assistantParams.content) {
      data.content = assistantParams.content;
    }
    if (data.document && !data.document.content && assistantParams.content) {
      data.document.content = assistantParams.content;
    }
  }

  // Show streaming content if available
  if (isStreaming && streamingContent) {
    // Create a temporary data structure for streaming display
    data = {
      success: true,
      document: {
        id: 'streaming',
        title: streamingContent.title || 'Creating document...',
        filename: 'streaming',
        format: 'doc',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        metadata: streamingContent.metadata || {},
        path: '',
        content: streamingContent.content || ''
      },
      content: streamingContent.content
    };
  } else if (isStreaming || !data) {
    return <LoadingState title="Processing Document..." />;
  }
  
  const getStatusIcon = () => {
    if (!data || !data.success || data.error) {
      return <AlertTriangle className="w-2 h-2 text-rose-500" />;
    }
    return <CheckCircle className="w-2 h-2 text-emerald-500" />;
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
              {getActionTitle(toolName)}
            </div>
          </div>
          
          <div className="flex items-center gap-2">
            {isStreaming && (
              <div className="flex items-center gap-1.5 px-2 py-1 bg-blue-50 dark:bg-blue-900/30 rounded-lg">
                <Loader2 className="h-3 w-3 animate-spin text-blue-600 dark:text-blue-400" />
                <span className="text-xs font-medium text-blue-700 dark:text-blue-300">Streaming</span>
              </div>
            )}
            {!isStreaming && data.document?.format === 'doc' && (
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
                    handleOpenInEditor(data.document, content, data);
                  }}
                >
                  <Pen className="h-3 w-3" />
                  Edit
                </Button>
                
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button size="sm" variant="outline" disabled={isExporting}>
                      {isExporting ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <Download className="h-3 w-3" />
                      )}
                      Export
                      <ChevronDown className="h-3 w-3" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    {project?.sandbox?.sandbox_url && data?.document?.path && (
                      <>
                        <DropdownMenuItem onClick={() => handleExport('google-docs')}>
                          <Share/>
                          Upload to Google Docs
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => handleExport('docx')}>
                          Export as DOCX
                        </DropdownMenuItem>
                      </>
                    )}
                    {!project?.sandbox?.sandbox_url && (
                      <DropdownMenuItem onClick={() => handleExport('docx')}>
                        Export as DOCX
                      </DropdownMenuItem>
                    )}
                    <DropdownMenuItem onClick={() => handleExport('txt')}>
                      Export as Text
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </>
            )}
            {!isStreaming && (
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
            )}
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
            {data.document && !data.documents ? (
              <div className="flex-1 min-h-0">
                {(data.document.path || data.content || data.document.content) && (
                  <div className="h-full overflow-y-auto p-4 scrollbar-thin scrollbar-thumb-zinc-200 dark:scrollbar-thumb-zinc-800 scrollbar-track-transparent">
                    {isStreaming && (
                      <div className="mb-3 flex items-center gap-2 text-sm text-muted-foreground">
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        <span>Content is streaming...</span>
                      </div>
                    )}
                    <div className="w-full max-w-none">
                      {data.document.path && data.sandbox_id && !isStreaming ? (
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
                  </div>
                )}
              </div>
            ) : null}
            {data.documents && data.documents.length === 0 && (
              <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
                <FileText className="h-12 w-12 mb-4 opacity-50" />
                <p className="text-sm">No documents found</p>
              </div>
            )}
            {data.message && !data.document && !data.documents && !data.sandbox_id && (
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
        onSave={() => {}}
      />
    )}
    </>
  );
} 