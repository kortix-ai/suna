'use client';

import React from 'react';
import { cn } from '@/lib/utils';
import { MarkdownEditor, type MarkdownEditorControls } from './markdown-editor';
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
  originalContent?: string; // The saved/persisted content (for tracking unsaved changes across remounts)
  hasUnsavedChanges?: boolean; // Controlled by parent - persists across remounts
  onUnsavedChange?: (hasUnsaved: boolean) => void; // Notify parent when unsaved state changes
  binaryUrl: string | null;
  fileName: string;
  filePath?: string;
  className?: string;
  project?: FileEditorProject;
  readOnly?: boolean;
  onChange?: (content: string) => void;
  onSave?: (content: string) => Promise<void>;
  onDiscard?: () => void; // Called when user discards changes
  onDownload?: () => void;
  isDownloading?: boolean;
  onFullScreen?: () => void;
  // Markdown editor specific
  hideMarkdownToolbarActions?: boolean;
  onMarkdownEditorReady?: (controls: MarkdownEditorControls | null) => void;
}

// Helper function to determine file type from extension
export function getEditableFileType(fileName: string): EditableFileType {
  const extension = fileName.split('.').pop()?.toLowerCase() || '';
  const fileNameLower = fileName.toLowerCase();

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
  
  // Check for common plain text file patterns (e.g., .env.example, .env.local, .gitignore, etc.)
  if (fileNameLower.includes('.env') || 
      fileNameLower.startsWith('.env') ||
      fileNameLower.includes('gitignore') ||
      fileNameLower.includes('editorconfig') ||
      fileNameLower.includes('dockerignore') ||
      fileNameLower.includes('npmignore') ||
      fileNameLower.includes('prettierignore') ||
      fileNameLower.includes('eslintignore')) {
    return 'text';
  }
  
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
  originalContent,
  hasUnsavedChanges,
  onUnsavedChange,
  binaryUrl,
  fileName,
  filePath,
  className,
  project,
  readOnly = false,
  onChange,
  onSave,
  onDiscard,
  onDownload,
  isDownloading,
  onFullScreen,
  hideMarkdownToolbarActions = false,
  onMarkdownEditorReady,
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

  // Check if we have text content even when fileType is 'binary'
  // This handles cases like .env.example where the extension isn't recognized
  // but we have text content that should be rendered
  const shouldRenderAsText = fileType === 'binary' && content !== null && !binaryUrl;

  return (
    <div className={cn('w-full h-full max-w-full max-h-full overflow-hidden min-w-0', className)} style={{ contain: 'strict' }}>
      {/* Binary files - not editable, unless we have text content */}
      {fileType === 'binary' && !shouldRenderAsText ? (
        <BinaryRenderer 
          url={binaryUrl || ''} 
          fileName={fileName} 
          onDownload={onDownload} 
          isDownloading={isDownloading} 
        />
      ) : shouldRenderAsText ? (
        // Render as plain text with CodeMirror when we have text content but fileType is binary
        <CodeEditor
          content={content || ''}
          originalContent={originalContent}
          hasUnsavedChanges={hasUnsavedChanges}
          onUnsavedChange={onUnsavedChange}
          fileName={fileName}
          language="text"
          onChange={onChange}
          onSave={onSave}
          onDiscard={onDiscard}
          readOnly={readOnly}
          className="h-full"
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
            originalContent={originalContent}
            hasUnsavedChanges={hasUnsavedChanges}
            onUnsavedChange={onUnsavedChange}
            onChange={onChange}
            onSave={onSave}
            onDiscard={onDiscard}
            readOnly={false}
            className="h-full"
            fileName={fileName}
            hideToolbarActions={hideMarkdownToolbarActions}
            onEditorReady={onMarkdownEditorReady}
            sandboxId={project?.sandbox?.id}
          />
        )
      ) : fileType === 'code' || fileType === 'text' ? (
        // Code and text files - CodeMirror editor
        <CodeEditor
          content={content || ''}
          originalContent={originalContent}
          hasUnsavedChanges={hasUnsavedChanges}
          onUnsavedChange={onUnsavedChange}
          fileName={fileName}
          onChange={onChange}
          onSave={onSave}
          onDiscard={onDiscard}
          readOnly={readOnly}
          className="h-full"
        />
      ) : (
        // Fallback - CodeMirror as plain text
        <CodeEditor
          content={content || ''}
          originalContent={originalContent}
          hasUnsavedChanges={hasUnsavedChanges}
          onUnsavedChange={onUnsavedChange}
          fileName={fileName}
          language="text"
          onChange={onChange}
          onSave={onSave}
          onDiscard={onDiscard}
          readOnly={readOnly}
          className="h-full"
        />
      )}
    </div>
  );
}

// Re-export components
export { MarkdownEditor, type MarkdownEditorControls } from './markdown-editor';
export { CodeEditor } from './code-editor';
export { UnifiedMarkdown } from '@/components/markdown';

// Re-export utilities
export { processUnicodeContent, getFileTypeFromExtension, getLanguageFromExtension } from './utils';


