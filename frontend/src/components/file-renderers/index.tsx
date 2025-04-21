"use client";

import React, { forwardRef } from "react";
import { cn } from "@/lib/utils";
import { MarkdownRenderer } from "./markdown-renderer";
import { CodeRenderer } from "./code-renderer";
import { PdfRenderer } from "./pdf-renderer";
import { ImageRenderer } from "./image-renderer";
import { BinaryRenderer } from "./binary-renderer";
import { HtmlRenderer } from "./html-renderer";

export type FileType = 
  | 'markdown'
  | 'code'
  | 'pdf'
  | 'image'
  | 'text'
  | 'binary';

interface FileRendererProps {
  content: string | null;
  binaryUrl: string | null;
  fileName: string;
  className?: string;
  project?: {
    sandbox?: {
      sandbox_url?: string;
      vnc_preview?: string;
      pass?: string;
    }
  };
  markdownRef?: React.RefObject<HTMLDivElement>;
}

// Helper function to determine file type from extension
export function getFileTypeFromExtension(fileName: string): FileType {
  const extension = fileName.split('.').pop()?.toLowerCase() || '';
  
  const markdownExtensions = ['md', 'markdown'];
  const codeExtensions = [
    'js', 'jsx', 'ts', 'tsx', 'html', 'css', 'json', 'py', 'python',
    'java', 'c', 'cpp', 'h', 'cs', 'go', 'rs', 'php', 'rb', 'sh', 'bash',
    'xml', 'yml', 'yaml', 'toml', 'sql', 'graphql', 'swift', 'kotlin',
    'dart', 'r', 'lua', 'scala', 'perl', 'haskell', 'rust'
  ];
  const imageExtensions = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico'];
  const pdfExtensions = ['pdf'];
  const textExtensions = ['txt', 'csv', 'log', 'env', 'ini'];
  
  if (markdownExtensions.includes(extension)) {
    return 'markdown';
  } else if (codeExtensions.includes(extension)) {
    return 'code';
  } else if (imageExtensions.includes(extension)) {
    return 'image';
  } else if (pdfExtensions.includes(extension)) {
    return 'pdf';
  } else if (textExtensions.includes(extension)) {
    return 'text';
  } else {
    return 'binary';
  }
}

// Helper function to get language from file extension for code highlighting
export function getLanguageFromExtension(fileName: string): string {
  const extension = fileName.split('.').pop()?.toLowerCase() || '';
  
  const extensionToLanguage: Record<string, string> = {
    js: 'javascript',
    jsx: 'jsx',
    ts: 'typescript',
    tsx: 'tsx',
    html: 'html',
    css: 'css',
    json: 'json',
    py: 'python',
    python: 'python',
    java: 'java',
    c: 'c',
    cpp: 'cpp',
    h: 'c',
    cs: 'csharp',
    go: 'go',
    rs: 'rust',
    php: 'php',
    rb: 'ruby',
    sh: 'shell',
    bash: 'shell',
    xml: 'xml',
    yml: 'yaml',
    yaml: 'yaml',
    sql: 'sql',
    // Add more mappings as needed
  };
  
  return extensionToLanguage[extension] || '';
}

export function FileRenderer({ 
  content, 
  binaryUrl, 
  fileName, 
  className, 
  project,
  markdownRef 
}: FileRendererProps) {
  const fileType = getFileTypeFromExtension(fileName);
  const language = getLanguageFromExtension(fileName);
  const isHtmlFile = fileName.toLowerCase().endsWith('.html');
  
  // Create blob URL for HTML content if needed
  const blobHtmlUrl = React.useMemo(() => {
    if (isHtmlFile && content && !project?.sandbox?.sandbox_url) {
      const blob = new Blob([content], { type: 'text/html' });
      return URL.createObjectURL(blob);
    }
    return undefined;
  }, [isHtmlFile, content, project?.sandbox?.sandbox_url]);
  
  // Construct HTML file preview URL if we have a sandbox and the file is HTML
  const htmlPreviewUrl = (isHtmlFile && project?.sandbox?.sandbox_url && fileName) 
    ? `${project.sandbox.sandbox_url}/${encodeURIComponent(fileName.replace(/^\/workspace\//, ''))}`
    : blobHtmlUrl; // Use blob URL as fallback
  
  // Clean up blob URL on unmount
  React.useEffect(() => {
    return () => {
      if (blobHtmlUrl) {
        URL.revokeObjectURL(blobHtmlUrl);
      }
    };
  }, [blobHtmlUrl]);
  
  return (
    <div className={cn("w-full h-full", className)}>
      {fileType === 'binary' ? (
        <BinaryRenderer 
          url={binaryUrl || ''} 
          fileName={fileName} 
        />
      ) : fileType === 'image' && binaryUrl ? (
        <ImageRenderer url={binaryUrl} />
      ) : fileType === 'pdf' && binaryUrl ? (
        <PdfRenderer url={binaryUrl} />
      ) : fileType === 'markdown' ? (
        <MarkdownRenderer content={content || ''} ref={markdownRef} />
      ) : isHtmlFile ? (
        <HtmlRenderer
          content={content || ''}
          previewUrl={htmlPreviewUrl || ''}
          className="w-full h-full"
        />
      ) : fileType === 'code' || fileType === 'text' ? (
        <CodeRenderer 
          content={content || ''} 
          language={language}
          className="w-full h-full"
        />
      ) : (
        <div className="w-full h-full p-4">
          <pre className="text-sm font-mono whitespace-pre-wrap break-words leading-relaxed bg-muted/30 p-4 rounded-lg overflow-auto max-h-full">
            {content || ''}
          </pre>
        </div>
      )}
    </div>
  );
} 