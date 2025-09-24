'use client';

import { useState, useCallback, useEffect } from 'react';
import type { Editor as TiptapEditor } from '@tiptap/react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { FileText, Check, Loader2, AlertCircle } from 'lucide-react';
import { toast } from 'sonner';
import { createClient } from '@/lib/supabase/client';
import { Editor } from '@/components/agents/docs-agent/editor';
import { AdvancedToolbar } from '@/components/agents/docs-agent/advanced-toolbar';
import { exportDocument, type ExportFormat } from '@/lib/utils/document-export';
import { KortixLogo } from '../sidebar/kortix-logo';
import { useDocumentModalStore } from '@/lib/stores/use-document-modal-store';

interface TipTapDocumentModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  filePath: string;
  documentData: {
    type?: string;
    version?: string;
    title?: string;
    content: string;
    metadata?: any;
    doc_id?: string;
    created_at?: string;
    updated_at?: string;
  };
  sandboxId: string;
  onSave?: () => void;
}

export function TipTapDocumentModal({
  open,
  onOpenChange,
  filePath,
  documentData,
  sandboxId,
  onSave,
}: TipTapDocumentModalProps) {
  const [saveState, setSaveState] = useState<'saving' | 'saved' | 'unsaved'>('saved');
  const [editorInstance, setEditorInstance] = useState<TiptapEditor | null>(null);
  const [wordCount, setWordCount] = useState(0);
  const [characterCount, setCharacterCount] = useState(0);
  const fileName = documentData.title || filePath.split('/').pop()?.replace('.json', '') || 'document';
  
  const { setIsOpen } = useDocumentModalStore();

  const documentId = `${sandboxId}-${filePath.replace(/\//g, '-')}`;

  useEffect(() => {
    console.log('TipTap modal open state changed:', open);
    setIsOpen(open);
  }, [open, setIsOpen]);

  const handleOpenChange = (newOpen: boolean) => {
    console.log('TipTap modal handleOpenChange:', newOpen);
    if (!newOpen) {
      setIsOpen(false);
    }
    onOpenChange(newOpen);
  };

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && (event.key === 'b' || event.key === 'i')) {
        event.stopImmediatePropagation();
      }
    };

    document.addEventListener('keydown', handleKeyDown, true);
    return () => {
      document.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [open]);

  const handleEditorChange = useCallback(async (content: string) => {
    try {
      const supabase = createClient();
      const { data: { session } } = await supabase.auth.getSession();
      
      if (!session?.access_token) {
        throw new Error('No access token available');
      }

      const updatedDocument = {
        ...documentData,
        content: content,
        updated_at: new Date().toISOString(),
      };

      const response = await fetch(
        `${process.env.NEXT_PUBLIC_BACKEND_URL}/sandboxes/${sandboxId}/files`,
        {
          method: 'PUT',
          headers: {
            'Authorization': `Bearer ${session.access_token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            path: filePath,
            content: JSON.stringify(updatedDocument, null, 2),
          }),
        }
      );

      if (!response.ok) {
        const error = await response.text();
        throw new Error(error || 'Failed to save document');
      }

      if (onSave) {
        onSave();
      }
    } catch (error) {
      console.error('Auto-save error:', error);
      toast.error(`Auto-save failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
      throw error;
    }
  }, [filePath, sandboxId, documentData, onSave]);

  const handleEditorReady = useCallback((editor: TiptapEditor) => {
    setEditorInstance(editor);
  }, []);

  const handleSaveStateChange = useCallback((state: 'saving' | 'saved' | 'unsaved') => {
    setSaveState(state);
  }, []);

  const handleStatsChange = useCallback((stats: { words: number; characters: number }) => {
    setWordCount(stats.words);
    setCharacterCount(stats.characters);
  }, []);

  const handleExport = useCallback(async (format: ExportFormat) => {
    if (!editorInstance) return;
    const content = editorInstance.getHTML();
    await exportDocument({
      content,
      fileName,
      format,
    });
  }, [editorInstance, fileName]);

  const SaveStateIndicator = () => {
    switch (saveState) {
      case 'saving':
        return (
          <Badge variant="secondary" className="gap-1">
            <Loader2 className="h-3 w-3 animate-spin" />
            Saving...
          </Badge>
        );
      case 'saved':
        return (
          <Badge variant="secondary" className="gap-1">
            <Check className="h-3 w-3" />
            Saved
          </Badge>
        );
      case 'unsaved':
        return (
          <Badge variant="secondary" className="gap-1">
            <AlertCircle className="h-3 w-3" />
            Unsaved changes
          </Badge>
        );
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-screen w-full h-screen rounded-none flex flex-col p-0">
        <DialogHeader className="px-4 py-3 border-b">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <KortixLogo size={24} />
              <DialogTitle>{fileName}</DialogTitle>
              <SaveStateIndicator />
            </div>
          </div>
        </DialogHeader>
        
        {editorInstance && (
          <AdvancedToolbar 
            editor={editorInstance}
            onExport={handleExport}
            wordCount={wordCount}
            characterCount={characterCount}
          />
        )}
        
        <div className="flex-1 -mt-4 overflow-auto bg-background">
          <Editor
            key={`${filePath}-${documentData?.updated_at}`}
            content={documentData.content || '<p></p>'}
            onChange={handleEditorChange}
            onEditorReady={handleEditorReady}
            onSaveStateChange={handleSaveStateChange}
            onStatsChange={handleStatsChange}
            useStore={false}
            documentId={documentId}
            autoSave={true}
            autoSaveDelay={2000}
            showWordCount={true}
            className="h-full"
            editorClassName="prose prose-sm sm:prose lg:prose-lg xl:prose-xl max-w-none focus:outline-none min-h-[400px] p-4 bg-white dark:bg-gray-900"
          />
        </div>
      </DialogContent>
    </Dialog>
  );
} 