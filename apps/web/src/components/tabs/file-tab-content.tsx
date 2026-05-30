'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CircleAlert, AlertTriangle } from 'lucide-react';
import { useTabStore, openTabAndNavigate } from '@/stores/tab-store';
import { FileContentRenderer } from '@/features/files/components/file-content-renderer';
import { useDiagnosticsStore, findDiagnosticsForFile } from '@/stores/diagnostics-store';
import { listFiles, useFilesStore } from '@/features/files';

/**
 * Standalone file viewer for the tab system.
 * Thin wrapper around FileContentRenderer that syncs dirty state
 * with the tab store, reads targetLine from tab metadata, and shows
 * diagnostics + file path in a footer bar.
 *
 * If the path is a directory (detected via listFiles), it automatically
 * redirects to the Files browser page at that directory.
 */

interface FileTabContentProps {
  /** The tab ID (e.g., "file:/path/to/file.ts") */
  tabId: string;
  /** The file path to display */
  filePath: string;
}

export function FileTabContent({ tabId, filePath }: FileTabContentProps) {
  const [hasUnsaved, setHasUnsaved] = useState(false);
  const [isDir, setIsDir] = useState<boolean | null>(null); // null = checking
  const dirCheckRef = useRef(false);

  // Read targetLine from tab metadata (set when navigating from diagnostics panel, chat, etc.)
  const targetLine = useTabStore(
    (s) => (s.tabs[tabId]?.metadata?.targetLine as number | undefined) ?? null,
  );

  // On mount: quick check if this path is a directory
  useEffect(() => {
    if (dirCheckRef.current) return;
    dirCheckRef.current = true;

    // Heuristic: if path has a file extension, skip the directory check
    const basename = filePath.split('/').pop() || '';
    if (basename.includes('.')) {
      setIsDir(false);
      return;
    }

    // No extension — could be a directory. Try listing it.
    listFiles(filePath)
      .then((entries) => {
        if (Array.isArray(entries) && entries.length >= 0) {
          // It's a directory — redirect
          setIsDir(true);
        } else {
          setIsDir(false);
        }
      })
      .catch(() => {
        // listFiles failed → it's a file (or doesn't exist)
        setIsDir(false);
      });
  }, [filePath]);

  // Redirect to files browser when directory is detected
  useEffect(() => {
    if (isDir !== true) return;

    // Navigate files store to this directory
    useFilesStore.getState().navigateToPath(filePath);

    // Close this file tab and open the files page tab
    useTabStore.getState().closeTab(tabId);
    openTabAndNavigate({
      id: 'page:/files',
      title: 'Files',
      type: 'page',
      href: '/files',
    });
  }, [isDir, filePath, tabId]);

  // LSP diagnostics for this file (suffix-matching for abs/rel path mismatch)
  const diagByFile = useDiagnosticsStore((s) => s.byFile);
  const fileDiagnostics = useMemo(
    () => findDiagnosticsForFile(diagByFile, filePath),
    [diagByFile, filePath],
  );
  const { errorCount, warningCount } = useMemo(() => {
    if (!fileDiagnostics || fileDiagnostics.length === 0) return { errorCount: 0, warningCount: 0 };
    let errors = 0;
    let warnings = 0;
    for (const d of fileDiagnostics) {
      if (d.severity === 1) errors++;
      else if (d.severity === 2) warnings++;
    }
    return { errorCount: errors, warningCount: warnings };
  }, [fileDiagnostics]);

  // Sync unsaved state to the tab store
  useEffect(() => {
    useTabStore.getState().setTabDirty(tabId, hasUnsaved);
  }, [tabId, hasUnsaved]);

  const handleUnsavedChange = useCallback((unsaved: boolean) => {
    setHasUnsaved(unsaved);
  }, []);

  // While checking if it's a directory, show nothing (instant check)
  if (isDir === null || isDir === true) {
    return null;
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 overflow-hidden">
        <FileContentRenderer
          filePath={filePath}
          showHeader
          onUnsavedChange={handleUnsavedChange}
          targetLine={targetLine}
        />
      </div>

      {/* Path bar footer with diagnostics summary */}
      <div className="flex items-center justify-between gap-4 px-3 py-1 border-t border-border/50 text-xs text-muted-foreground/50 shrink-0">
        <span className="truncate">{filePath}</span>
        {(errorCount > 0 || warningCount > 0) && (
          <span className="inline-flex items-center gap-2 shrink-0">
            {errorCount > 0 && (
              <span className="inline-flex items-center gap-0.5 text-red-500/80">
                <CircleAlert className="h-2.5 w-2.5" />
                {errorCount}
              </span>
            )}
            {warningCount > 0 && (
              <span className="inline-flex items-center gap-0.5 text-yellow-500/80">
                <AlertTriangle className="h-2.5 w-2.5" />
                {warningCount}
              </span>
            )}
          </span>
        )}
      </div>
    </div>
  );
}
