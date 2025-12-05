'use client';

import React from 'react';
import { cn } from '@/lib/utils';
import { MarkdownEditor } from './markdown-editor';
import { UnifiedMarkdown } from '@/components/markdown';
import { CodeEditor } from './code-editor';
import { PdfRenderer } from '@/components/file-renderers/pdf-renderer';
import { ImageRenderer } from '@/components/file-renderers/image-renderer';
import { BinaryRenderer } from '@/components/file-renderers/binary-renderer';
import { CsvRenderer } from '@/components/file-renderers/csv-renderer';
import { XlsxRenderer } from '@/components/file-renderers/xlsx-renderer';
import { PptxRenderer } from '@/components/file-renderers/pptx-renderer';
import { HtmlRenderer } from '@/components/file-renderers/html-renderer';
import { constructHtmlPreviewUrl } from '@/lib/utils/url';
import { processUnicodeContent, getFileTypeFromExtension, getLanguageFromExtension } from './utils';

export type EditableFileType =
  | 'markdown'
  | 'code'
  | 'text'
  | 'html'
  | 'pdf'
  | 'image'
  | 'binary'
  | 'csv'
  | 'xlsx'
  | 'pptx';

export interface FileEditorProject {
  id?: string;
  name?: string;
  description?: string;
  created_at?: string;
  sandbox?: {
    id?: string;
    sandbox_url?: string;
    vnc_preview?: string;
    pass?: string;
  };
}

interface EditableFileRendererProps {
  content: string | null;
  binaryUrl: string | null;
  fileName: string;
  filePath?: string;
  className?: string;
  project?: FileEditorProject;
  readOnly?: boolean;
  onChange?: (content: string) => void;
  onSave?: (content: string) => Promise<void>;
  onDownload?: () => void;
  isDownloading?: boolean;
  onFullScreen?: () => void;
}

// Helper function to determine file type from extension
export function getEditableFileType(fileName: string): EditableFileType {
  const extension = fileName.split('.').pop()?.toLowerCase() || '';

  const markdownExtensions = ['md', 'markdown'];
  const htmlExtensions = ['html', 'htm'];
  const codeExtensions = [
    'js', 'jsx', 'ts', 'tsx', 'css', 'json', 'py', 'python',
    'java', 'c', 'cpp', 'h', 'hpp', 'cs', 'go', 'rs', 'php',
    'rb', 'sh', 'bash', 'zsh', 'xml', 'yml', 'yaml', 'toml',
    'sql', 'graphql', 'swift', 'kotlin', 'kt', 'dart', 'r',
    'lua', 'scala', 'perl', 'pl', 'haskell', 'hs', 'rust',
    'dockerfile', 'makefile', 'cmake',
  ];
  const textExtensions = ['txt', 'log', 'env', 'ini', 'conf', 'cfg', 'gitignore', 'editorconfig'];
  const imageExtensions = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico'];
  const pdfExtensions = ['pdf'];
  const csvExtensions = ['csv', 'tsv'];
  const xlsxExtensions = ['xlsx', 'xls'];
  const pptxExtensions = ['pptx', 'ppt'];

  if (markdownExtensions.includes(extension)) return 'markdown';
  if (htmlExtensions.includes(extension)) return 'html';
  if (codeExtensions.includes(extension)) return 'code';
  if (textExtensions.includes(extension)) return 'text';
  if (imageExtensions.includes(extension)) return 'image';
  if (pdfExtensions.includes(extension)) return 'pdf';
  if (csvExtensions.includes(extension)) return 'csv';
  if (xlsxExtensions.includes(extension)) return 'xlsx';
  if (pptxExtensions.includes(extension)) return 'pptx';
  
  return 'binary';
}

// Check if file type supports editing
export function isEditableFileType(fileType: EditableFileType): boolean {
  return ['markdown', 'code', 'text', 'html'].includes(fileType);
}

export function EditableFileRenderer({
  content,
  binaryUrl,
  fileName,
  filePath,
  className,
  project,
  readOnly = false,
  onChange,
  onSave,
  onDownload,
  isDownloading,
  onFullScreen,
}: EditableFileRendererProps) {
  const fileType = getEditableFileType(fileName);
  const isHtmlFile = fileName.toLowerCase().endsWith('.html') || fileName.toLowerCase().endsWith('.htm');

  // HTML preview URL for HTML files
  const htmlPreviewUrl = React.useMemo(() => {
    if (isHtmlFile && content && !project?.sandbox?.sandbox_url) {
      const blob = new Blob([content], { type: 'text/html' });
      return URL.createObjectURL(blob);
    }
    if (isHtmlFile && project?.sandbox?.sandbox_url && (filePath || fileName)) {
      return constructHtmlPreviewUrl(project.sandbox.sandbox_url, filePath || fileName);
    }
    return undefined;
  }, [isHtmlFile, content, project?.sandbox?.sandbox_url, filePath, fileName]);

  // Cleanup blob URLs
  React.useEffect(() => {
    return () => {
      if (htmlPreviewUrl && htmlPreviewUrl.startsWith('blob:')) {
        URL.revokeObjectURL(htmlPreviewUrl);
      }
    };
  }, [htmlPreviewUrl]);

  return (
    <div className={cn('w-full h-full overflow-hidden', className)} style={{ contain: 'layout size' }}>
      {/* Binary files - not editable */}
      {fileType === 'binary' ? (
        <BinaryRenderer 
          url={binaryUrl || ''} 
          fileName={fileName} 
          onDownload={onDownload} 
          isDownloading={isDownloading} 
        />
      ) : fileType === 'image' && binaryUrl ? (
        <ImageRenderer url={binaryUrl} />
      ) : fileType === 'pdf' && binaryUrl ? (
        <PdfRenderer url={binaryUrl} />
      ) : fileType === 'csv' ? (
        <CsvRenderer content={content || ''} />
      ) : fileType === 'xlsx' ? (
        <XlsxRenderer
          content={content}
          filePath={filePath}
          fileName={fileName}
          project={project}
          onDownload={onDownload}
          isDownloading={isDownloading}
        />
      ) : fileType === 'pptx' ? (
        <PptxRenderer
          content={content}
          binaryUrl={binaryUrl}
          filePath={filePath}
          fileName={fileName}
          project={project}
          onDownload={onDownload}
          isDownloading={isDownloading}
          onFullScreen={onFullScreen}
        />
      ) : fileType === 'html' && htmlPreviewUrl ? (
        // HTML files - show preview (could add split view editor later)
        <HtmlRenderer
          content={content || ''}
          previewUrl={htmlPreviewUrl}
          className="w-full h-full"
          project={project}
        />
      ) : fileType === 'markdown' ? (
        // Markdown - use UnifiedMarkdown for read-only, Editor for editing
        readOnly ? (
          <div className="h-full overflow-auto p-6">
            <UnifiedMarkdown content={content || ''} />
          </div>
        ) : (
          <MarkdownEditor
            content={content || ''}
            onChange={onChange}
            onSave={onSave}
            readOnly={false}
            className="h-full"
          />
        )
      ) : fileType === 'code' || fileType === 'text' ? (
        // Code and text files - CodeMirror editor
        <CodeEditor
          content={content || ''}
          fileName={fileName}
          onChange={onChange}
          onSave={onSave}
          readOnly={readOnly}
          className="h-full"
        />
      ) : (
        // Fallback - CodeMirror as plain text
        <CodeEditor
          content={content || ''}
          fileName={fileName}
          language="text"
          onChange={onChange}
          onSave={onSave}
          readOnly={readOnly}
          className="h-full"
        />
      )}
    </div>
  );
}

// Re-export components
export { MarkdownEditor } from './markdown-editor';
export { CodeEditor } from './code-editor';
export { UnifiedMarkdown } from '@/components/markdown';

// Re-export utilities
export { processUnicodeContent, getFileTypeFromExtension, getLanguageFromExtension } from './utils';


