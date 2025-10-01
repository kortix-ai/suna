'use client';

import React, { forwardRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize from 'rehype-sanitize';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import { CodeRenderer } from './code-renderer';
import { useImageContent } from '@/hooks/use-image-content';
import { MermaidRenderer } from '@/components/ui/mermaid-renderer';
import { isMermaidCode } from '@/lib/mermaid-utils';
import type { FileRendererProject } from './index';

// Process Unicode escape sequences in content
export const processUnicodeContent = (content: any, forCodeBlock: boolean = false): string => {
  console.log('🔍 processUnicodeContent called with:', typeof content, 'forCodeBlock:', forCodeBlock, content);
  
  // Handle different content types
  if (!content) {
    return '';
  }
  
  // If it's an object (like JSON), stringify it
  if (typeof content === 'object') {
    console.log('📊 Converting object to formatted JSON string');
    try {
      const jsonString = JSON.stringify(content, null, 2);
      // Only wrap in markdown if not for code block (to avoid double-wrapping)
      if (forCodeBlock) {
        return jsonString;
      } else {
        return '```json\n' + jsonString + '\n```';
      }
    } catch (error) {
      console.warn('❌ Failed to stringify object:', error);
      return String(content);
    }
  }
  
  // If it's not a string, convert to string
  if (typeof content !== 'string') {
    console.warn('⚠️ Converting non-string content to string:', typeof content);
    return String(content);
  }

  // Process \uXXXX Unicode escape sequences (BMP characters)
  const bmpProcessed = content.replace(
    /\\u([0-9a-fA-F]{4})/g,
    (_, codePoint) => {
      return String.fromCharCode(parseInt(codePoint, 16));
    },
  );

  // Process \uXXXXXXXX Unicode escape sequences (supplementary plane characters)
  return bmpProcessed.replace(/\\u([0-9a-fA-F]{8})/g, (_, codePoint) => {
    const highSurrogate = parseInt(codePoint.substring(0, 4), 16);
    const lowSurrogate = parseInt(codePoint.substring(4, 8), 16);
    return String.fromCharCode(highSurrogate, lowSurrogate);
  });
};

// Authenticated image component using existing useImageContent hook
interface AuthenticatedImageProps {
  src: string;
  alt?: string;
  className?: string;
  project?: FileRendererProject;
  basePath?: string;
}

// Join and normalize paths like a simplified path.resolve for URLs
function joinAndNormalize(baseDir: string, relativePath: string): string {
  // Ensure baseDir starts with a leading slash
  let base = baseDir.startsWith('/') ? baseDir : `/${baseDir}`;

  // If base appears to be a file path, remove the file name to get the directory
  if (base.includes('.')) {
    base = base.substring(0, base.lastIndexOf('/')) || '/';
  }

  // Ensure we are rooted at /workspace
  if (!base.startsWith('/workspace')) {
    base = `/workspace/${base.replace(/^\//, '')}`;
  }

  const stack: string[] = base.split('/').filter(Boolean);
  const segments = relativePath.split('/');

  for (const segment of segments) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (stack.length > 1) stack.pop(); // keep at least 'workspace'
    } else {
      stack.push(segment);
    }
  }

  return `/${stack.join('/')}`;
}

function normalizeWorkspacePath(path: string): string {
  if (!path) return '/workspace';
  let normalized = path;
  if (!normalized.startsWith('/workspace')) {
    normalized = `/workspace/${normalized.replace(/^\//, '')}`;
  }
  return normalized;
}

function resolveImagePath(src: string, basePath?: string): string {
  if (!src) return src;
  const lower = src.toLowerCase();
  // External or data/blob URLs should pass through
  if (lower.startsWith('http://') || lower.startsWith('https://') || lower.startsWith('data:') || lower.startsWith('blob:')) {
    return src;
  }

  // Already absolute workspace path
  if (src.startsWith('/workspace/')) {
    return src;
  }

  // Root-relative to workspace or absolute without /workspace
  if (src.startsWith('/')) {
    return normalizeWorkspacePath(src);
  }

  // Relative path -> resolve against basePath directory
  if (basePath) {
    return joinAndNormalize(basePath, src);
  }

  // Fallback: treat as under workspace root
  return normalizeWorkspacePath(src);
}

function AuthenticatedImage({ src, alt, className, project, basePath }: AuthenticatedImageProps) {
  // For sandbox files, use the existing useImageContent hook
  const sandboxId = typeof project?.sandbox === 'string' 
    ? project.sandbox 
    : project?.sandbox?.id;

  const resolvedSrc = resolveImagePath(src, basePath);
  const { data: imageUrl, isLoading, error } = useImageContent(sandboxId, resolvedSrc);

  // If it's already a URL or data URL, use regular img
  if (src.startsWith('http') || src.startsWith('data:') || src.startsWith('blob:')) {
    return <img src={src} alt={alt || ''} className={className} />;
  }

  if (isLoading) {
    return (
      <span className={cn("inline-block p-2 bg-muted/30 rounded text-xs text-muted-foreground", className)}>
        Loading image...
      </span>
    );
  }

  if (error || !imageUrl) {
    return (
      <span className={cn("inline-block p-2 bg-muted/30 rounded border border-dashed text-xs text-muted-foreground", className)}>
        Failed to load: {alt || src}
      </span>
    );
  }

  return (
    <img
      src={imageUrl}
      alt={alt || ''}
      className={className}
    />
  );
}

interface MarkdownRendererProps {
  content: string;
  className?: string;
  project?: FileRendererProject;
  basePath?: string; // used to resolve relative image sources inside markdown
}

export const MarkdownRenderer = forwardRef<
  HTMLDivElement,
  MarkdownRendererProps
>(({ content, className, project, basePath }, ref) => {
  // Process Unicode escape sequences in the content
  const processedContent = processUnicodeContent(content);

  return (
    <ScrollArea className={cn('w-full h-full rounded-md relative', className)}>
      <div
        className="p-4 markdown prose prose-sm dark:prose-invert max-w-none"
        ref={ref}
      >
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          rehypePlugins={[rehypeRaw, rehypeSanitize]}
          components={{
            code(props) {
              const { className, children, ...rest } = props;
              const match = /language-(\w+)/.exec(className || '');
              const language = match ? match[1] : '';
              const code = String(children).replace(/\n$/, '');

              // Check if it's an inline code block by examining the node type
              const isInline = !className || !match;

              if (isInline) {
                return (
                  <code className={className} {...rest}>
                    {children}
                  </code>
                );
              }

              // Check if this is a Mermaid diagram
              if (isMermaidCode(language, code)) {
                return <MermaidRenderer chart={code} className="my-4" />;
              }

              return (
                <CodeRenderer
                  content={code}
                  language={language}
                />
              );
            },
            // Style other elements as needed
            h1: ({ node, ...props }) => (
              <h1 className="text-2xl font-bold my-4" {...props} />
            ),
            h2: ({ node, ...props }) => (
              <h2 className="text-xl font-bold my-3" {...props} />
            ),
            h3: ({ node, ...props }) => (
              <h3 className="text-lg font-bold my-2" {...props} />
            ),
            a: ({ node, ...props }) => (
              <a className="text-primary hover:underline" {...props} />
            ),
            p: ({ node, ...props }) => (
              <p className="my-2 font-sans cjk-text" {...props} />
            ),
            ul: ({ node, ...props }) => (
              <ul className="list-disc pl-5 my-2" {...props} />
            ),
            ol: ({ node, ...props }) => (
              <ol className="list-decimal pl-5 my-2" {...props} />
            ),
            li: ({ node, ...props }) => <li className="my-1" {...props} />,
            blockquote: ({ node, ...props }) => (
              <blockquote
                className="border-l-4 border-muted pl-4 italic my-2"
                {...props}
              />
            ),
            img: ({ node, ...props }) => (
              <AuthenticatedImage
                src={props.src || ''}
                alt={props.alt || ''}
                className="max-w-full h-auto rounded-md my-2"
                project={project}
                basePath={basePath}
              />
            ),
            pre: ({ node, ...props }) => (
              <pre className="p-0 my-2 bg-transparent" {...props} />
            ),
            table: ({ node, ...props }) => (
              <table
                className="w-full border-collapse my-3 text-sm"
                {...props}
              />
            ),
            th: ({ node, ...props }) => (
              <th
                className="border border-slate-300 dark:border-zinc-700 px-3 py-2 text-left font-semibold bg-slate-100 dark:bg-zinc-800"
                {...props}
              />
            ),
            td: ({ node, ...props }) => (
              <td
                className="border border-slate-300 dark:border-zinc-700 px-3 py-2 cjk-text"
                {...props}
              />
            ),
          }}
        >
          {processedContent}
        </ReactMarkdown>
      </div>
    </ScrollArea>
  );
});

MarkdownRenderer.displayName = 'MarkdownRenderer';
