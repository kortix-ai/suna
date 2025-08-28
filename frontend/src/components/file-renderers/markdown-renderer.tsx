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
import type { FileRendererProject } from './index';

// Process Unicode escape sequences in content
export const processUnicodeContent = (content: string): string => {
  if (!content) return '';

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
}

function AuthenticatedImage({ src, alt, className, project }: AuthenticatedImageProps) {
  // For sandbox files, use the existing useImageContent hook
  const sandboxId = typeof project?.sandbox === 'string' 
    ? project.sandbox 
    : project?.sandbox?.id;

  const { data: imageUrl, isLoading, error } = useImageContent(sandboxId, src);

  // If it's already a URL or data URL, use regular img
  if (src.startsWith('http') || src.startsWith('data:')) {
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
}

export const MarkdownRenderer = forwardRef<
  HTMLDivElement,
  MarkdownRendererProps
>(({ content, className, project }, ref) => {
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

              // Check if it's an inline code block by examining the node type
              const isInline = !className || !match;

              if (isInline) {
                return (
                  <code className={className} {...rest}>
                    {children}
                  </code>
                );
              }

              return (
                <CodeRenderer
                  content={String(children).replace(/\n$/, '')}
                  language={match ? match[1] : ''}
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
