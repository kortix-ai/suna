import { memo, useRef, useEffect } from 'react';
import { Streamdown } from 'streamdown';
import { cn } from '@/lib/utils';

interface InlineReasoningProps {
  content: string;
  isStreaming?: boolean;
  className?: string;
}

export const InlineReasoning = memo(function InlineReasoning({
  content,
  isStreaming = false,
  className
}: InlineReasoningProps) {
  // Freeze content after initial render to ensure immutability
  // This prevents re-animation when parent re-renders
  const frozenContentRef = useRef<string | null>(null);
  const contentLengthRef = useRef<number>(0);

  useEffect(() => {
    // Only update frozen content if new content is longer (streaming in)
    if (content && content.length > contentLengthRef.current) {
      frozenContentRef.current = content;
      contentLengthRef.current = content.length;
    }
    // Reset when content is cleared
    if (!content || content.length === 0) {
      frozenContentRef.current = null;
      contentLengthRef.current = 0;
    }
  }, [content]);

  const displayContent = frozenContentRef.current ?? content;

  if (!displayContent || displayContent.trim().length === 0) {
    return null;
  }

  return (
    <div className={cn(
      "my-2 pl-3 py-2 border-l-2 border-muted-foreground/30 rounded-r",
      className
    )}>
      <div className="text-sm text-muted-foreground">
        <Streamdown
          isAnimating={isStreaming}
          components={{
            p: ({ children }) => (
              <p className="text-sm text-muted-foreground leading-relaxed my-1.5 first:mt-0 last:mb-0">
                {children}
              </p>
            ),
            h1: ({ children }) => (
              <h1 className="text-sm font-semibold text-muted-foreground mt-3 mb-1.5 first:mt-0">
                {children}
              </h1>
            ),
            h2: ({ children }) => (
              <h2 className="text-sm font-semibold text-muted-foreground mt-2 mb-1 first:mt-0">
                {children}
              </h2>
            ),
            h3: ({ children }) => (
              <h3 className="text-sm font-medium text-muted-foreground mt-2 mb-1 first:mt-0">
                {children}
              </h3>
            ),
            ul: ({ children }) => (
              <ul className="my-1.5 ml-4 list-disc marker:text-muted-foreground/60 space-y-0.5 text-sm">
                {children}
              </ul>
            ),
            ol: ({ children }) => (
              <ol className="my-1.5 ml-4 list-decimal marker:text-muted-foreground/60 space-y-0.5 text-sm">
                {children}
              </ol>
            ),
            li: ({ children }) => (
              <li className="text-sm text-muted-foreground leading-relaxed">
                {children}
              </li>
            ),
            code: ({ children, className: codeClassName }) => {
              const code = String(children).replace(/\n$/, '');
              const isBlock = codeClassName?.includes('language-') || code.includes('\n');

              if (isBlock) {
                return (
                  <code className="text-xs font-mono leading-relaxed text-foreground whitespace-pre block my-1.5 p-2 rounded bg-muted/50 border border-border/40">
                    {children}
                  </code>
                );
              }

              return (
                <code className="px-1 py-0.5 rounded text-xs font-mono bg-muted/50 border border-border/40 text-foreground">
                  {children}
                </code>
              );
            },
            pre: ({ children }) => (
              <pre className="my-1.5 overflow-x-auto">
                {children}
              </pre>
            ),
            blockquote: ({ children }) => (
              <blockquote className="my-1.5 pl-3 py-1 text-sm border-l-2 border-border text-muted-foreground">
                {children}
              </blockquote>
            ),
            strong: ({ children }) => (
              <strong className="font-semibold text-foreground">
                {children}
              </strong>
            ),
            em: ({ children }) => (
              <em className="italic text-muted-foreground">
                {children}
              </em>
            ),
            a: ({ href, children }) => (
              <a
                href={href}
                target={href?.startsWith('http') ? '_blank' : undefined}
                rel={href?.startsWith('http') ? 'noopener noreferrer' : undefined}
                className="text-muted-foreground underline decoration-muted-foreground/30 underline-offset-2 hover:decoration-muted-foreground/60 transition-colors"
              >
                {children}
              </a>
            ),
          }}
        >
          {displayContent}
        </Streamdown>
      </div>
    </div>
  );
});
