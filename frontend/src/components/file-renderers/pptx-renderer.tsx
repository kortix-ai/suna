'use client';

import React, { useState, useEffect, useMemo } from 'react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  Loader2,
  Download,
  AlertTriangle,
} from 'lucide-react';
import DocViewer, { DocViewerRenderers } from '@cyntler/react-doc-viewer';
import '@cyntler/react-doc-viewer/dist/index.css';
import { constructHtmlPreviewUrl } from '@/lib/utils/url';

interface PptxRendererProps {
  content?: string | null;
  binaryUrl?: string | null;
  filePath?: string;
  fileName: string;
  className?: string;
  sandboxId?: string;
  project?: {
    sandbox?: {
      id?: string;
      sandbox_url?: string;
    };
  };
  onDownload?: () => void;
  isDownloading?: boolean;
  onFullScreen?: () => void;
}

export function PptxRenderer({
  binaryUrl,
  filePath,
  fileName,
  className,
  project,
  onDownload,
  isDownloading,
}: PptxRendererProps) {
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  
  // Build the public URL for the PPTX file
  const publicUrl = useMemo(() => {
    // Priority 1: Build URL from sandbox_url + filePath
    if (project?.sandbox?.sandbox_url && filePath) {
      const url = constructHtmlPreviewUrl(project.sandbox.sandbox_url, filePath);
      console.log('[PptxRenderer] Public URL:', url);
      return url || null;
    }
    
    // Priority 2: Use binaryUrl if it's already a public URL
    if (binaryUrl && !binaryUrl.startsWith('blob:')) {
      return binaryUrl;
    }
    
    return null;
  }, [binaryUrl, filePath, project?.sandbox?.sandbox_url]);
  
  // Documents configuration for react-doc-viewer
  const documents = useMemo(() => {
    if (!publicUrl) return [];
    return [{
      uri: publicUrl,
      fileName: fileName,
      fileType: fileName.endsWith('.ppt') ? 'ppt' : 'pptx',
    }];
  }, [publicUrl, fileName]);

  // Handle loading states
  useEffect(() => {
    if (publicUrl) {
      setIsLoading(false);
      setError(null);
    } else if (!project?.sandbox?.sandbox_url && filePath) {
      setIsLoading(false);
      setError('Waiting for computer to start...');
    } else if (!filePath && binaryUrl?.startsWith('blob:')) {
      setIsLoading(false);
      setError('Cannot preview local file.');
    } else if (!filePath && !binaryUrl) {
      setIsLoading(false);
      setError('No file available');
    } else {
      setIsLoading(true);
    }
  }, [publicUrl, binaryUrl, filePath, project?.sandbox?.sandbox_url]);

  // Loading state
  if (isLoading) {
    return (
      <div className={cn('w-full h-full flex items-center justify-center', className)}>
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  // Error state
  if (error || !publicUrl) {
    return (
      <div className={cn('w-full h-full flex items-center justify-center', className)}>
        <div className="text-center space-y-3 p-6">
          <AlertTriangle className="h-8 w-8 text-amber-500 mx-auto" />
          <p className="text-sm text-muted-foreground">
            {error || 'Cannot preview'}
          </p>
          {onDownload && (
            <Button size="sm" onClick={onDownload} disabled={isDownloading}>
              {isDownloading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4 mr-2" />}
              Download
            </Button>
          )}
        </div>
      </div>
    );
  }

  // Render DocViewer - fills entire container
  return (
    <div 
      className={cn('w-full h-full', className)}
      style={{ minHeight: '500px' }}
    >
      <style>{`
        #react-doc-viewer {
          height: 100% !important;
          min-height: 500px !important;
        }
        #react-doc-viewer > div {
          height: 100% !important;
        }
        #proxy-renderer {
          height: 100% !important;
        }
        #msdoc-renderer {
          height: 100% !important;
        }
        #msdoc-iframe {
          height: 100% !important;
          min-height: 500px !important;
        }
      `}</style>
      <DocViewer
        documents={documents}
        pluginRenderers={DocViewerRenderers}
        config={{
          header: {
            disableHeader: true,
            disableFileName: true,
          },
        }}
        style={{ 
          width: '100%', 
          height: '100%',
          minHeight: '500px',
        }}
      />
    </div>
  );
}






