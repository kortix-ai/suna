'use client';

import { History } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useFilesStore } from '../store/files-store';
import { FileContentRenderer } from './file-content-renderer';

/**
 * File viewer panel used inside the FileExplorerPage.
 * Thin wrapper around FileContentRenderer that reads from the files store
 * and adds explorer-specific actions (e.g. history).
 */
export function FileViewer() {
  const selectedFilePath = useFilesStore((s) => s.selectedFilePath);
  const openHistory = useFilesStore((s) => s.openHistory);

  if (!selectedFilePath) return null;

  return (
    <FileContentRenderer
      filePath={selectedFilePath}
      showHeader
      readOnly
      headerActions={
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 text-muted-foreground/60 hover:text-foreground"
          onClick={() => openHistory(selectedFilePath)}
          title="History"
        >
          <History className="h-4 w-4" />
        </Button>
      }
    />
  );
}
