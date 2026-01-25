'use client';

import React, { useState, useCallback } from 'react';
import { Download, FileType, FileText, FileCode } from 'lucide-react';
import { KortixLoader } from '@/components/ui/kortix-loader';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { exportDocument, type ExportFormat } from '@/lib/utils/document-export';
import { useDownloadRestriction } from '@/hooks/billing';
import { toast } from '@/lib/toast';
import { marked } from 'marked';

interface FileDownloadButtonProps {
  /** The file content to download/export */
  content: string;
  /** The file name (used to determine if it's markdown and for download naming) */
  fileName: string;
  /** Whether the component is disabled */
  disabled?: boolean;
  /** Custom class name for the button */
  className?: string;
  /** Optional function to get rendered HTML content (from an editor) - if provided, uses this instead of marked conversion */
  getHtmlContent?: () => string;
  /** Optional sandbox URL for high-quality PDF export via Playwright */
  sandboxUrl?: string;
}

/**
 * A reusable file download button that:
 * - For markdown files: Shows a dropdown with PDF, Word, HTML, Markdown export options
 * - For other files: Shows a simple download button
 * 
 * This component is used in both FileOperationToolView and FileViewerView
 * to ensure consistent download/export behavior.
 */
export function FileDownloadButton({
  content,
  fileName,
  disabled = false,
  className,
  getHtmlContent,
  sandboxUrl,
}: FileDownloadButtonProps) {
  const [isExporting, setIsExporting] = useState(false);
  
  // Download restriction for free tier users
  const { isRestricted: isDownloadRestricted, openUpgradeModal } = useDownloadRestriction({
    featureName: 'files',
  });

  // Check if file is markdown or HTML
  const fileExtension = fileName.split('.').pop()?.toLowerCase() || '';
  const isMarkdown = fileExtension === 'md' || fileExtension === 'markdown';
  const isHtml = fileExtension === 'html' || fileExtension === 'htm';

  // Handle direct file download (for non-markdown or markdown "raw" download)
  const handleDirectDownload = useCallback(async () => {
    if (isDownloadRestricted) {
      openUpgradeModal();
      return;
    }
    if (!content || isExporting) return;

    try {
      setIsExporting(true);
      const blob = new Blob([content], { type: 'application/octet-stream' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName || 'file';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      toast.success(`Downloaded ${fileName}`);
    } catch (error) {
      console.error('Download error:', error);
      toast.error('Failed to download file');
    } finally {
      setIsExporting(false);
    }
  }, [content, fileName, isExporting, isDownloadRestricted, openUpgradeModal]);

  // Handle markdown export to various formats (PDF, Word, HTML, Markdown)
  const handleMarkdownExport = useCallback(async (format: ExportFormat) => {
    if (isDownloadRestricted) {
      openUpgradeModal();
      return;
    }
    if (!content) return;

    setIsExporting(true);
    try {
      const baseFileName = fileName.replace(/\.(md|markdown)$/i, '');

      if (format === 'markdown') {
        // For markdown format, just download the raw content
        const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${baseFileName}.md`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        toast.success(`Downloaded ${baseFileName}.md`);
      } else {
        // For PDF, Word, HTML - get HTML content
        // If getHtmlContent is provided (from editor), use it; otherwise convert markdown to HTML
        const htmlContent = getHtmlContent ? getHtmlContent() : await marked(content);

        await exportDocument({
          content: htmlContent,
          fileName: baseFileName,
          format,
        });
      }
    } catch (error) {
      console.error('Export error:', error);
      toast.error('Failed to export file');
    } finally {
      setIsExporting(false);
    }
  }, [content, fileName, isDownloadRestricted, openUpgradeModal, getHtmlContent]);

  // Handle HTML file export to various formats (PDF, Word, HTML)
  const handleHtmlExport = useCallback(async (format: ExportFormat) => {
    if (isDownloadRestricted) {
      openUpgradeModal();
      return;
    }
    if (!content) return;

    setIsExporting(true);
    try {
      const baseFileName = fileName.replace(/\.(html|htm)$/i, '');

      if (format === 'html') {
        // For HTML format, just download the raw content
        const blob = new Blob([content], { type: 'text/html;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${baseFileName}.html`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        toast.success(`Downloaded ${baseFileName}.html`);
      } else if (format === 'pdf' && sandboxUrl) {
        // Use sandbox Playwright for high-quality PDF export
        const toastId = toast.loading('Exporting to PDF...');
        try {
          const response = await fetch(`${sandboxUrl}/presentation/html-to-pdf`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              content: content,
              file_name: baseFileName,
            }),
          });

          if (!response.ok) {
            const errorText = await response.text();
            throw new Error(errorText || `Export failed: ${response.status}`);
          }

          const blob = await response.blob();
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = `${baseFileName}.pdf`;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
          toast.dismiss(toastId);
          toast.success('PDF exported');
        } catch (error) {
          console.error('Sandbox PDF export error:', error);
          toast.dismiss(toastId);
          toast.error(`PDF export failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
      } else {
        // For Word or PDF without sandbox - use backend API
        await exportDocument({
          content: content,
          fileName: baseFileName,
          format,
        });
      }
    } catch (error) {
      console.error('Export error:', error);
      toast.error('Failed to export file');
    } finally {
      setIsExporting(false);
    }
  }, [content, fileName, isDownloadRestricted, openUpgradeModal, sandboxUrl]);

  // For markdown files, show dropdown with export options
  if (isMarkdown) {
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className={className || "h-8 w-8 p-0"}
            disabled={disabled || isExporting || !content}
            title="Export file"
          >
            {isExporting ? (
              <KortixLoader customSize={16} />
            ) : (
              <Download className="h-4 w-4" />
            )}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={() => handleMarkdownExport('pdf')}>
            <FileType className="h-4 w-4 text-muted-foreground" />
            PDF
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => handleMarkdownExport('docx')}>
            <FileText className="h-4 w-4 text-muted-foreground" />
            Word
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => handleMarkdownExport('html')}>
            <FileCode className="h-4 w-4 text-muted-foreground" />
            HTML
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => handleMarkdownExport('markdown')}>
            <FileCode className="h-4 w-4 text-muted-foreground" />
            Markdown
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  // For HTML files, show dropdown with export options (PDF, Word, HTML)
  if (isHtml) {
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className={className || "h-8 w-8 p-0"}
            disabled={disabled || isExporting || !content}
            title="Export file"
          >
            {isExporting ? (
              <KortixLoader customSize={16} />
            ) : (
              <Download className="h-4 w-4" />
            )}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={() => handleHtmlExport('pdf')}>
            <FileType className="h-4 w-4 text-muted-foreground" />
            PDF
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => handleHtmlExport('html')}>
            <FileCode className="h-4 w-4 text-muted-foreground" />
            HTML
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  // For non-markdown files, show simple download button
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={handleDirectDownload}
      disabled={disabled || isExporting || !content}
      className={className || "h-8 w-8 p-0"}
      title="Download file"
    >
      {isExporting ? (
        <KortixLoader customSize={16} />
      ) : (
        <Download className="h-4 w-4" />
      )}
    </Button>
  );
}
