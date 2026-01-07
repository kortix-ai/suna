'use client';

import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import React from 'react';
import { FullScreenFileViewer } from '@/components/file-viewer/FullScreenFileViewer';

export type FileViewerType = 'image' | 'pdf' | 'spreadsheet' | 'document' | 'other';

interface FileViewerState {
  isOpen: boolean;
  sandboxId?: string;
  filePath?: string;
  fileName?: string;
  displayName?: string;
  fileType?: FileViewerType;
  accessToken?: string;
  
  openFile: (params: {
    sandboxId: string;
    filePath: string;
    fileName: string;
    displayName?: string;
    accessToken?: string;
  }) => void;
  closeFile: () => void;
}

// Helper to detect file type from filename
export function getFileViewerType(fileName: string): FileViewerType {
  const ext = fileName.split('.').pop()?.toLowerCase() || '';
  
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'ico', 'tiff'].includes(ext)) {
    return 'image';
  }
  if (ext === 'pdf') {
    return 'pdf';
  }
  if (['xlsx', 'xls', 'csv', 'ods'].includes(ext)) {
    return 'spreadsheet';
  }
  if (['txt', 'md', 'json', 'xml', 'yaml', 'yml', 'html', 'htm'].includes(ext)) {
    return 'document';
  }
  return 'other';
}

export const useFileViewerStore = create<FileViewerState>()(
  devtools(
    (set) => ({
      isOpen: false,
      sandboxId: undefined,
      filePath: undefined,
      fileName: undefined,
      displayName: undefined,
      fileType: undefined,
      accessToken: undefined,
      
      openFile: ({ sandboxId, filePath, fileName, displayName, accessToken }) => {
        const fileType = getFileViewerType(fileName);
        set({
          isOpen: true,
          sandboxId,
          filePath,
          fileName,
          displayName: displayName || fileName,
          fileType,
          accessToken,
        });
      },
      
      closeFile: () => {
        set({
          isOpen: false,
          sandboxId: undefined,
          filePath: undefined,
          fileName: undefined,
          displayName: undefined,
          fileType: undefined,
          accessToken: undefined,
        });
      },
    }),
    {
      name: 'file-viewer-store',
    }
  )
);

// Hook for easy access
export function useFileViewer() {
  const store = useFileViewerStore();
  
  return {
    isOpen: store.isOpen,
    openFile: store.openFile,
    closeFile: store.closeFile,
  };
}

// Component wrapper to render the FullScreenFileViewer
export function FileViewerWrapper() {
  const { 
    isOpen, 
    sandboxId, 
    filePath, 
    fileName, 
    displayName,
    fileType,
    accessToken,
    closeFile 
  } = useFileViewerStore();
  
  return (
    <FullScreenFileViewer
      isOpen={isOpen}
      onClose={closeFile}
      sandboxId={sandboxId}
      filePath={filePath}
      fileName={fileName}
      displayName={displayName}
      fileType={fileType}
      accessToken={accessToken}
    />
  );
}




