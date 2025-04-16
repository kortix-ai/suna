"use client";

import React from "react";
import { cn } from "@/lib/utils";
import { MarkdownRenderer } from "./markdown-renderer";
import { CodeRenderer } from "./code-renderer";
import { PdfRenderer } from "./pdf-renderer";
import { ImageRenderer } from "./image-renderer";
import { BinaryRenderer } from "./binary-renderer";

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

export function FileRenderer({ content, binaryUrl, fileName, className }: FileRendererProps) {
  const fileType = getFileTypeFromExtension(fileName);
  const language = getLanguageFromExtension(fileName);
  
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
        <MarkdownRenderer content={content || ''} />
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