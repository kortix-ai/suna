'use client';

import { useCallback, useRef, useState } from 'react';
import { droppedEntries, type DroppedEntry } from '../drop-tree';
import type { FileNode } from '@/features/file-browser/types';
import { DRAG_MIME } from '@/features/file-browser/components/file-tree-item';
import { rowDragIntent } from '../upload-batch';
import { decodeDragPaths, encodeDragPaths, useDriveSelection } from './drive-selection';
import { useRequestRename } from './drive-rename-dialog';

interface DriveRowInteractions {
  node: FileNode;
  onRename?: (node: FileNode, newName: string) => void;
  onDropMove?: (sourcePath: string, targetDirPath: string) => void;
  onDropUpload?: (files: File[], targetDirPath: string, entries?: DroppedEntry[]) => void;
  selectRenameInput: (el: HTMLInputElement) => void;
}

export function useDriveRowInteractions({
  node, onRename, onDropMove, onDropUpload, selectRenameInput,
}: DriveRowInteractions) {
  const isDir = node.type === 'directory';
  const selection = useDriveSelection();
  const requestRename = useRequestRename();
  const [isDragOver, setIsDragOver] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameName, setRenameName] = useState('');
  const renameInputRef = useRef<HTMLInputElement>(null);
  const dragCounterRef = useRef(0);

  const handleDragStart = useCallback(
    (e: React.DragEvent) => {
      // A selected item drags the whole selection with it.
      const paths = selection?.dragPaths(node) ?? [node.path];
      e.dataTransfer.setData(DRAG_MIME, encodeDragPaths(paths));
      e.dataTransfer.setData('text/plain', paths.length === 1 ? node.name : `${paths.length} items`);
      e.dataTransfer.effectAllowed = 'move';
      setIsDragging(true);
    },
    [node, selection],
  );

  const handleDragEnd = useCallback(() => setIsDragging(false), []);

  /** `move` (internal drag), `upload` (external files), or null (ignore). */
  const intentOf = useCallback(
    (e: React.DragEvent) =>
      rowDragIntent(Array.from(e.dataTransfer.types), {
        isDirectory: isDir,
        canMove: Boolean(onDropMove),
        canUpload: Boolean(onDropUpload),
        moveMime: DRAG_MIME,
      }),
    [isDir, onDropMove, onDropUpload],
  );

  const handleDragOver = useCallback(
    (e: React.DragEvent) => {
      const intent = intentOf(e);
      if (!intent) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = intent === 'upload' ? 'copy' : 'move';
    },
    [intentOf],
  );

  const handleDragEnter = useCallback(
    (e: React.DragEvent) => {
      if (!intentOf(e)) return;
      e.preventDefault();
      dragCounterRef.current++;
      setIsDragOver(true);
    },
    [intentOf],
  );

  const handleDragLeave = useCallback(() => {
    if (!isDir) return;
    dragCounterRef.current--;
    if (dragCounterRef.current <= 0) {
      dragCounterRef.current = 0;
      setIsDragOver(false);
    }
  }, [isDir]);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      const intent = intentOf(e);
      if (!intent) return;
      e.preventDefault();
      e.stopPropagation();
      dragCounterRef.current = 0;
      setIsDragOver(false);

      if (intent === 'upload') {
        // Always notify, even for an empty transfer: this drop is stopped
        // before the page handler, which owns the drop overlay's reset.
        onDropUpload?.(Array.from(e.dataTransfer.files ?? []), node.path, droppedEntries(e.dataTransfer));
        return;
      }

      // Never into itself or into a folder inside it.
      for (const sourcePath of decodeDragPaths(e.dataTransfer.getData(DRAG_MIME))) {
        if (sourcePath === node.path || node.path.startsWith(sourcePath + '/')) continue;
        onDropMove?.(sourcePath, node.path);
      }
    },
    [intentOf, node.path, onDropMove, onDropUpload],
  );

  // Enter commits, and so does the blur when the input then goes away: one
  // rename per edit, not two (the second answered "not found").
  const renameCommittedRef = useRef(false);

  const startRenaming = useCallback(() => {
    // The explorer renames in its modal; inline editing is the fallback for
    // a host without one.
    if (requestRename) {
      requestRename(node);
      return;
    }
    renameCommittedRef.current = false;
    setRenameName(node.name);
    setIsRenaming(true);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const el = renameInputRef.current;
        if (el) selectRenameInput(el);
      });
    });
  }, [node, requestRename, selectRenameInput]);

  // Closing the editor any other way (Escape) is a cancel: the blur that
  // follows must not commit the half-typed name.
  const setRenaming = useCallback((renaming: boolean) => {
    if (!renaming) renameCommittedRef.current = true;
    setIsRenaming(renaming);
  }, []);

  const confirmRename = useCallback(() => {
    if (renameCommittedRef.current) return;
    renameCommittedRef.current = true;
    const trimmed = renameName.trim();
    if (trimmed && trimmed !== node.name) {
      onRename?.(node, trimmed);
    }
    setIsRenaming(false);
  }, [renameName, node, onRename]);

  return {
    isDragOver, isDragging, isRenaming, setIsRenaming: setRenaming, renameName, setRenameName,
    renameInputRef, handleDragStart, handleDragEnd, handleDragOver, handleDragEnter,
    handleDragLeave, handleDrop, startRenaming, confirmRename,
  };
}
