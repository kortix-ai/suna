'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Button } from '@/components/ui/button';
import {
  X,
  Download,
  FileText,
  Image as ImageIcon,
  FileSpreadsheet,
  File,
} from 'lucide-react';
import { KortixLoader } from '@/components/ui/kortix-loader';
import { ImageRenderer } from '@/components/file-renderers/image-renderer';
import { PdfRenderer } from '@/components/file-renderers/pdf-renderer';
import { XlsxRenderer } from '@/components/file-renderers/xlsx-renderer';
import { CsvRenderer } from '@/components/file-renderers/csv-renderer';
import { JsonRenderer } from '@/components/file-renderers/JsonRenderer';
import type { FileViewerType } from '@/stores/file-viewer-store';
import { toast } from '@/lib/toast';

interface FullScreenFileViewerProps {
  isOpen: boolean;
  onClose: () => void;
  sandboxId?: string;
  filePath?: string;
  fileName?: string;
  displayName?: string;
  fileType?: FileViewerType;
  accessToken?: string;
}

// Get icon based on file type
function getFileIcon(fileType: FileViewerType) {
  switch (fileType) {
    case 'image':
      return ImageIcon;
    case 'pdf':
      return FileText;
    case 'spreadsheet':
      return FileSpreadsheet;
    case 'document':
      return FileText;
    default:
      return File;
  }
}

export function FullScreenFileViewer({
  isOpen,
  onClose,
  sandboxId,
  filePath,
  fileName,
  displayName,
  fileType,
  accessToken,
}: FullScreenFileViewerProps) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [textContent, setTextContent] = useState<string | null>(null);
  const blobUrlRef = useRef<string | null>(null);

  // Fetch file content with authentication
  const fetchFile = useCallback(async () => {
    if (!sandboxId || !filePath || !accessToken) {
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const url = `${process.env.NEXT_PUBLIC_BACKEND_URL}/sandboxes/${sandboxId}/files/content?path=${encodeURIComponent(filePath)}`;
      
      const response = await fetch(url, {
        headers: { 'Authorization': `Bearer ${accessToken}` }
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch file: ${response.status}`);
      }

      // For text/document files, get text content
      if (fileType === 'document') {
        const text = await response.text();
        setTextContent(text);
        setIsLoading(false);
        return;
      }

      // For CSV files, get text content
      const ext = fileName?.split('.').pop()?.toLowerCase();
      if (fileType === 'spreadsheet' && ext === 'csv') {
        const text = await response.text();
        setTextContent(text);
        setIsLoading(false);
        return;
      }

      // For binary files, create blob URL
      const blob = await response.blob();
      const newBlobUrl = URL.createObjectURL(blob);
      
      // Clean up previous blob URL
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current);
      }
      
      blobUrlRef.current = newBlobUrl;
      setBlobUrl(newBlobUrl);
      setIsLoading(false);
    } catch (err) {
      console.error('Error fetching file:', err);
      setError(err instanceof Error ? err.message : 'Failed to load file');
      setIsLoading(false);
    }
  }, [sandboxId, filePath, accessToken, fileType]);

  // Fetch file when viewer opens
  useEffect(() => {
    if (isOpen && sandboxId && filePath) {
      fetchFile();
    }

    return () => {
      // Clean up blob URL on unmount or close
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current);
        blobUrlRef.current = null;
      }
      setBlobUrl(null);
      setTextContent(null);
      setError(null);
    };
  }, [isOpen, sandboxId, filePath, fetchFile]);

  // Keyboard navigation - Escape to close
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };

    document.addEventListener('keydown', handleKeyDown, true);
    return () => document.removeEventListener('keydown', handleKeyDown, true);
  }, [isOpen, onClose]);

  // Handle download
  const handleDownload = useCallback(async () => {
    if (!sandboxId || !filePath || !accessToken) return;

    try {
      const url = `${process.env.NEXT_PUBLIC_BACKEND_URL}/sandboxes/${sandboxId}/files/content?path=${encodeURIComponent(filePath)}`;
      
      const response = await fetch(url, {
        headers: { 'Authorization': `Bearer ${accessToken}` }
      });

      if (!response.ok) {
        throw new Error(`Failed to download file: ${response.status}`);
      }

      const blob = await response.blob();
      const downloadUrl = URL.createObjectURL(blob);
      
      const a = document.createElement('a');
      a.href = downloadUrl;
      a.download = fileName || 'download';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(downloadUrl);
      
      toast.success('File downloaded');
    } catch (err) {
      console.error('Download failed:', err);
      toast.error('Failed to download file');
    }
  }, [sandboxId, filePath, accessToken, fileName]);

  // Render content based on file type
  const renderContent = () => {
    if (isLoading) {
      return (
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center">
            <KortixLoader size="medium" />
            <p className="mt-4 text-sm text-zinc-500 dark:text-zinc-400">Loading file...</p>
          </div>
        </div>
      );
    }

    if (error) {
      return (
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center">
            <File className="h-12 w-12 mx-auto mb-4 text-zinc-400" />
            <p className="text-sm text-red-500">{error}</p>
            <Button variant="outline" onClick={fetchFile} className="mt-4">
              Retry
            </Button>
          </div>
        </div>
      );
    }

    // Check if we have content based on file type
    const ext = fileName?.split('.').pop()?.toLowerCase();
    const isCsv = fileType === 'spreadsheet' && ext === 'csv';
    const hasContent = isCsv ? textContent : (blobUrl || textContent);
    
    if (!hasContent) {
      return (
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center">
            <File className="h-12 w-12 mx-auto mb-4 text-zinc-400" />
            <p className="text-sm text-zinc-500 dark:text-zinc-400">No content to display</p>
          </div>
        </div>
      );
    }

    switch (fileType) {
      case 'image':
        return (
          <div className="flex-1 overflow-hidden p-4">
            <ImageRenderer url={blobUrl!} className="h-full w-full" />
          </div>
        );

      case 'pdf':
        return (
          <div className="flex-1 overflow-hidden">
            <PdfRenderer url={blobUrl!} className="h-full w-full" />
          </div>
        );

      case 'spreadsheet':
        // Check if it's CSV or XLSX
        const ext = fileName?.split('.').pop()?.toLowerCase();
        if (ext === 'csv' && textContent) {
          return (
            <div className="flex-1 overflow-auto p-4">
              <CsvRenderer content={textContent} className="h-full w-full" />
            </div>
          );
        }
        return (
          <div className="flex-1 overflow-auto p-4">
            <XlsxRenderer 
              filePath={filePath} 
              fileName={fileName || 'spreadsheet.xlsx'} 
              sandboxId={sandboxId}
              className="h-full w-full" 
            />
          </div>
        );

      case 'document':
        // Check if it's JSON
        const docExt = fileName?.split('.').pop()?.toLowerCase();
        if (docExt === 'json' && textContent) {
          return (
            <div className="flex-1 overflow-auto p-4">
              <JsonRenderer content={textContent} />
            </div>
          );
        }
        
        // Display as text
        return (
          <div className="flex-1 overflow-auto p-4">
            <pre className="bg-zinc-100 dark:bg-zinc-900 rounded-lg p-4 text-sm font-mono whitespace-pre-wrap break-words">
              {textContent}
            </pre>
          </div>
        );

      default:
        return (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center">
              <File className="h-16 w-16 mx-auto mb-4 text-zinc-400" />
              <p className="text-lg font-medium text-zinc-900 dark:text-zinc-100 mb-2">
                {displayName || fileName}
              </p>
              <p className="text-sm text-zinc-500 dark:text-zinc-400 mb-6">
                This file type cannot be previewed
              </p>
              <Button onClick={handleDownload}>
                <Download className="h-4 w-4 mr-2" />
                Download File
              </Button>
            </div>
          </div>
        );
    }
  };

  if (!isOpen) return null;

  const IconComponent = getFileIcon(fileType || 'other');

  return (
    <div className="fixed inset-0 z-50 bg-black/90 backdrop-blur-sm flex flex-col">
      {/* Top Controls Bar */}
      <div className="flex-shrink-0 bg-white dark:bg-zinc-950 border-b border-zinc-200 dark:border-zinc-800">
        <div className="flex items-center justify-between p-4">
          <div className="flex items-center gap-3">
            <div className="relative p-2 rounded-lg border flex-shrink-0 bg-zinc-200/60 dark:bg-zinc-900 border-zinc-300 dark:border-zinc-700">
              <IconComponent className="w-5 h-5 text-zinc-500 dark:text-zinc-400" />
            </div>
            
            <div>
              <h1 className="text-base font-medium text-zinc-900 dark:text-zinc-100">
                {displayName || fileName || 'File'}
              </h1>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {/* Download Button */}
            <Button
              variant="outline"
              size="sm"
              onClick={handleDownload}
              className="gap-2"
            >
              <Download className="h-4 w-4" />
              Download
            </Button>

            {/* Close Button */}
            <Button
              variant="ghost"
              size="icon"
              onClick={onClose}
              className="h-9 w-9"
            >
              <X className="h-5 w-5" />
            </Button>
          </div>
        </div>
      </div>

      {/* Content Area */}
      <div className="flex-1 flex flex-col overflow-hidden bg-zinc-100 dark:bg-zinc-900">
        {renderContent()}
      </div>
    </div>
  );
}

