'use client';

import React, { useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import {
  FileText,
  CheckCircle,
  AlertTriangle,
  Calendar,
  Tag,
  Eye,
  Edit,
  Trash2,
  FolderOpen,
} from 'lucide-react';
import { ToolViewProps } from '../types';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { LoadingState } from '../shared/LoadingState';
import { cn } from '@/lib/utils';
import { FileViewerModal } from '@/components/thread/file-viewer-modal';
import { TipTapDocumentModal } from '@/components/thread/tiptap-document-modal';
import { 
  DocumentInfo, 
  extractDocsData,
  extractToolName,
} from './_utils';

export function ListDocumentsToolView({
  name = 'list_documents',
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
  
  const data = extractDocsData(toolContent);

  if (isStreaming || !data) {
    return <LoadingState title="Loading Documents..." />;
  }
  
  const getStatusIcon = () => {
    if (!data || !data.success || data.error) {
      return <AlertTriangle className="w-2 h-2 text-rose-500" />;
    }
    return <CheckCircle className="w-2 h-2 text-emerald-500" />;
  };
  
  const handleViewDocument = (doc: DocumentInfo) => {
    if (doc.path) {
      setSelectedDocPath(doc.path);
      setFileViewerOpen(true);
    }
  };
  
  const handleEditDocument = async (doc: DocumentInfo) => {
    let content = doc.content || '';
    
    // Try to fetch the latest content from the sandbox first
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
                content = parsedDocument.content;
              }
            } catch {}
          }
        }
      } catch (error) {
        console.error('Failed to fetch latest content:', error);
      }
    }
    
    const documentData = {
      type: 'tiptap_document',
      version: '1.0',
      title: doc.title,
      content: content,
      metadata: doc.metadata || {},
      created_at: doc.created_at,
      updated_at: doc.updated_at || new Date().toISOString(),
      doc_id: doc.id
    };
    
    setEditorDocumentData(documentData);
    setEditorFilePath(doc.path);
    setEditorOpen(true);
  };

  const formatDate = (dateString: string) => {
    if (!dateString) return 'Unknown';
    try {
      return new Date(dateString).toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      });
    } catch {
      return dateString;
    }
  };
  
  return (
    <>
    <Card className="gap-0 flex border shadow-none border-t border-b-0 border-x-0 p-0 rounded-none flex-col h-full overflow-hidden bg-card">
      <CardHeader className="h-14 bg-zinc-50/80 dark:bg-zinc-900/80 backdrop-blur-sm border-b p-2 px-4 space-y-2">
        <div className="flex flex-row items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="relative p-2 rounded-xl bg-gradient-to-br from-blue-500/20 to-purple-600/10 border border-blue-500/20">
              <FolderOpen className="w-5 h-5 text-blue-500 dark:text-blue-400" />
            </div>
            <div>
              <CardTitle className="text-base font-medium text-zinc-900 dark:text-zinc-100">
                Documents Library
              </CardTitle>
            </div>
          </div>
          
          <div className="flex items-center gap-2">
            {data.count !== undefined && (
              <Badge variant="secondary" className="bg-zinc-100 dark:bg-zinc-800">
                {data.count} {data.count === 1 ? 'document' : 'documents'}
              </Badge>
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
      
      <CardContent className="flex-1 p-4 overflow-hidden">
        {data.error ? (
          <div className="flex items-center gap-2 p-4 bg-rose-50 dark:bg-rose-900/20 rounded-lg">
            <AlertTriangle className="h-5 w-5 text-rose-500" />
            <span className="text-sm text-rose-700 dark:text-rose-300">
              {data.error}
            </span>
          </div>
        ) : (
          <ScrollArea className="h-full">
            {data.documents && data.documents.length > 0 ? (
              <div className="space-y-3">
                {data.documents.map((doc: DocumentInfo) => (
                  <div
                    key={doc.id}
                    className="group relative p-4 border rounded-lg bg-background hover:bg-accent/50 transition-colors"
                  >
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex items-start gap-3 flex-1">
                        <div className="p-2 rounded-lg bg-blue-50 dark:bg-blue-900/20">
                          <FileText className="h-4 w-4 text-blue-500 dark:text-blue-400" />
                        </div>
                        <div className="flex-1 space-y-1">
                          <h3 className="font-medium text-sm text-zinc-900 dark:text-zinc-100">
                            {doc.title}
                          </h3>
                          <div className="flex items-center gap-4 text-xs text-muted-foreground">
                            <span className="flex items-center gap-1">
                              <Calendar className="h-3 w-3" />
                              {formatDate(doc.updated_at || doc.created_at)}
                            </span>
                            {doc.format && (
                              <Badge variant="outline" className="text-xs px-2 py-0">
                                {doc.format === 'doc' ? 'TipTap' : doc.format.toUpperCase()}
                              </Badge>
                            )}
                          </div>
                          {doc.metadata?.tags && doc.metadata.tags.length > 0 && (
                            <div className="flex items-center gap-1 mt-2">
                              <Tag className="h-3 w-3 text-muted-foreground" />
                              {doc.metadata.tags.map((tag: string) => (
                                <Badge key={tag} variant="secondary" className="text-xs">
                                  {tag}
                                </Badge>
                              ))}
                            </div>
                          )}
                        </div>
                      </div>
                      
                      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                        {doc.path && (
                          <>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => handleViewDocument(doc)}
                              className="h-8 w-8 p-0"
                            >
                              <Eye className="h-4 w-4" />
                            </Button>
                            {doc.format === 'doc' && (
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => handleEditDocument(doc)}
                                className="h-8 w-8 p-0"
                              >
                                <Edit className="h-4 w-4" />
                              </Button>
                            )}
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
                <FolderOpen className="h-12 w-12 mb-4 opacity-50" />
                <p className="text-sm">No documents found</p>
              </div>
            )}
          </ScrollArea>
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