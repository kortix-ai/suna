'use client';

import React, { useState, useCallback, useRef, useEffect } from 'react';
import Link from 'next/link';
import { Streamdown } from 'streamdown';
import { Check, Copy } from 'lucide-react';
import { cn } from '@/lib/utils';
import { MermaidRenderer } from '@/components/ui/mermaid-renderer';
import { isMermaidCode } from '@/lib/mermaid-utils';
import { autoLinkUrls } from '@/lib/utils/url-autolink';

// Helper to check if a URL is internal (same origin)
function isInternalUrl(href: string | undefined): boolean {
  if (!href) return false;
  
  // External URLs (http/https/mailto/tel)
  if (href.startsWith('http://') || href.startsWith('https://')) {
    return false;
  }
  
  // Protocol links (mailto, tel, etc.)
  if (href.includes('://')) {
    return false;
  }
  
  // Internal links (starting with / or #)
  return href.startsWith('/') || href.startsWith('#');
}

// Helper to handle hash link clicks for smooth scrolling
function handleHashClick(e: React.MouseEvent<HTMLAnchorElement>, href: string) {
  if (href.startsWith('#')) {
    e.preventDefault();
    const targetId = href.substring(1);
    const element = document.getElementById(targetId);
    
    if (element) {
      element.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }
}

// Copy button component for code blocks
function CopyButton({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  }, [code]);

  return (
    <button
      onClick={handleCopy}
      className={cn(
        "absolute top-3 right-3 p-1.5 rounded-md",
        "opacity-0 group-hover:opacity-100 transition-opacity duration-150",
        "bg-zinc-200/80 hover:bg-zinc-300 dark:bg-zinc-700/80 dark:hover:bg-zinc-600",
        "text-zinc-600 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200",
        "focus:outline-none focus:ring-1 focus:ring-zinc-400 dark:focus:ring-zinc-500"
      )}
      aria-label={copied ? "Copied!" : "Copy code"}
    >
      {copied ? (
        <Check className="h-4 w-4 text-green-600 dark:text-green-400" />
      ) : (
        <Copy className="h-4 w-4" />
      )}
    </button>
  );
}

// Code block component with copy functionality
function CodeBlock({ children }: { children: React.ReactNode }) {
  const preRef = useRef<HTMLPreElement>(null);
  const [codeText, setCodeText] = useState('');

  useEffect(() => {
    if (preRef.current) {
      const codeElement = preRef.current.querySelector('code');
      if (codeElement) {
        const text = codeElement.textContent || '';
        setCodeText(text.trim());
      }
    }
  }, [children]);

  return (
    <div className="relative group my-5">
      <pre 
        ref={preRef}
        className={cn(
          "p-4 rounded-xl overflow-x-auto",
          "bg-zinc-100 dark:bg-zinc-900",
          "border border-zinc-200 dark:border-zinc-800",
          "text-[13px] font-mono leading-relaxed",
          "text-zinc-800 dark:text-zinc-200",
          "[&_code]:bg-transparent [&_code]:text-inherit [&_code]:p-0"
        )}
      >
        {children}
      </pre>
      {codeText && <CopyButton code={codeText} />}
    </div>
  );
}

export interface UnifiedMarkdownProps {
  content: string;
  className?: string;
  isStreaming?: boolean; // Enable streaming animation for incomplete markdown
}

/**
 * UNIFIED MARKDOWN RENDERER
 * 
 * Single source of truth for all markdown rendering across the application.
 * Optimized for Kortix brand with Vercel-level UX/UI polish.
 * 
 * Design principles:
 * - Clean, minimal aesthetic
 * - Consistent spacing rhythm
 * - Excellent readability in light & dark modes
 * - Brand-aligned colors and border radius
 */
export const UnifiedMarkdown = React.memo<UnifiedMarkdownProps>(({
  content,
  className,
  isStreaming = false,
}) => {
  if (!content) {
    return (
      <div className={cn('text-muted-foreground text-sm', className)}>
        No content
      </div>
    );
  }

  // Auto-link plain URLs before rendering
  const processedContent = autoLinkUrls(content);

  return (
    <div className={cn('kortix-markdown', className)}>
      <Streamdown
        isAnimating={isStreaming}
        components={{
          // ═══════════════════════════════════════════════════════════════
          // HEADINGS - Clean hierarchy with proper weight distribution
          // ═══════════════════════════════════════════════════════════════
          h1: ({ children }) => (
            <h1 className="text-2xl font-semibold tracking-tight text-foreground mt-8 mb-4 first:mt-0 pb-2 border-b border-border/40">
              {children}
            </h1>
          ),
          h2: ({ children }) => (
            <h2 className="text-xl font-semibold tracking-tight text-foreground mt-8 mb-3 first:mt-0">
              {children}
            </h2>
          ),
          h3: ({ children }) => (
            <h3 className="text-lg font-semibold text-foreground mt-6 mb-2 first:mt-0">
              {children}
            </h3>
          ),
          h4: ({ children }) => (
            <h4 className="text-base font-semibold text-foreground mt-5 mb-2 first:mt-0">
              {children}
            </h4>
          ),
          h5: ({ children }) => (
            <h5 className="text-sm font-semibold text-foreground mt-4 mb-1 first:mt-0">
              {children}
            </h5>
          ),
          h6: ({ children }) => (
            <h6 className="text-sm font-medium text-muted-foreground mt-4 mb-1 first:mt-0 uppercase tracking-wide">
              {children}
            </h6>
          ),

          // ═══════════════════════════════════════════════════════════════
          // PARAGRAPHS - Optimal line height for readability
          // ═══════════════════════════════════════════════════════════════
          p: ({ children }) => (
            <p className="text-sm text-foreground leading-relaxed my-4 first:mt-0 last:mb-0 [&:has(img)]:my-0">
              {children}
            </p>
          ),

          // ═══════════════════════════════════════════════════════════════
          // LISTS - Clean bullets with proper spacing
          // ═══════════════════════════════════════════════════════════════
          ul: ({ children }) => (
            <ul className="my-4 ml-6 list-disc marker:text-muted-foreground/60 space-y-2 first:mt-0 last:mb-0 text-sm">
              {children}
            </ul>
          ),
          ol: ({ children }) => (
            <ol className="my-4 ml-6 list-decimal marker:text-muted-foreground/60 marker:font-medium space-y-2 first:mt-0 last:mb-0 text-sm">
              {children}
            </ol>
          ),
          li: ({ children }) => (
            <li className="text-sm text-foreground leading-relaxed pl-1">
              {children}
            </li>
          ),

          // ═══════════════════════════════════════════════════════════════
          // LINKS - Subtle, professional styling with Next.js routing
          // ═══════════════════════════════════════════════════════════════
          a: ({ href, children }) => {
            const isInternal = isInternalUrl(href);
            const isHashLink = href?.startsWith('#');
            const linkClassName = cn(
              "font-medium text-foreground",
              "underline decoration-foreground/30 underline-offset-[3px] decoration-[1px]",
              "hover:decoration-foreground/60 transition-colors duration-150"
            );

            if (isHashLink) {
              // Hash links use smooth scroll
              return (
                <a
                  href={href}
                  onClick={(e) => handleHashClick(e, href)}
                  className={linkClassName}
                >
                  {children}
                </a>
              );
            }

            if (isInternal) {
              // Internal links use Next.js Link for client-side navigation
              return (
                <Link
                  href={href || '#'}
                  className={linkClassName}
                >
                  {children}
                </Link>
              );
            }

            // External links open in new tab
            return (
              <a
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                className={linkClassName}
              >
                {children}
              </a>
            );
          },

          // ═══════════════════════════════════════════════════════════════
          // CODE - Clean, readable code styling with copy button
          // ═══════════════════════════════════════════════════════════════
          code: ({ children, className: codeClassName }) => {
            const match = /language-(\w+)/.exec(codeClassName || '');
            const language = match ? match[1] : '';
            const code = String(children).replace(/\n$/, '');
            const isBlock = codeClassName?.includes('language-');

            if (isBlock) {
              // Mermaid diagrams
              if (isMermaidCode(language, code)) {
                return <MermaidRenderer chart={code} className="my-5" />;
              }

              // Block code inside pre - inherit styles
              return (
                <code className="text-[13px] leading-relaxed text-inherit">
                  {children}
                </code>
              );
            }

            // Inline code - subtle pill style
            return (
              <code className="px-2 py-1 rounded-md text-[13px] font-mono bg-card dark:bg-[#161618] border border-neutral-200 dark:border-neutral-700/50 text-foreground">
                {children}
              </code>
            );
          },
          pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,

          // ═══════════════════════════════════════════════════════════════
          // BLOCKQUOTES - Clean side border
          // ═══════════════════════════════════════════════════════════════
          blockquote: ({ children }) => (
            <blockquote className={cn(
              "my-5 pl-4 py-1 text-sm",
              "border-l-2 border-border",
              "text-muted-foreground",
              "[&>p]:my-2"
            )}>
              {children}
            </blockquote>
          ),

          // ═══════════════════════════════════════════════════════════════
          // HORIZONTAL RULE - Subtle divider
          // ═══════════════════════════════════════════════════════════════
          hr: () => (
            <hr className="my-8 border-0 h-px bg-border/60" />
          ),

          // ═══════════════════════════════════════════════════════════════
          // TABLES - Clean, modern table design
          // ═══════════════════════════════════════════════════════════════
          table: ({ children }) => (
            <div className="my-5 overflow-x-auto rounded-xl border border-border/60">
              <table className="w-full text-sm">
                {children}
              </table>
            </div>
          ),
          thead: ({ children }) => (
            <thead className="bg-muted/50 dark:bg-muted/30 border-b border-border/60">
              {children}
            </thead>
          ),
          tbody: ({ children }) => (
            <tbody className="divide-y divide-border/40">
              {children}
            </tbody>
          ),
          tr: ({ children }) => (
            <tr className="transition-colors hover:bg-muted/30">
              {children}
            </tr>
          ),
          th: ({ children }) => (
            <th className="px-4 py-3 text-left text-xs font-semibold text-foreground uppercase tracking-wider">
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td className="px-4 py-3 text-foreground">
              {children}
            </td>
          ),

          // ═══════════════════════════════════════════════════════════════
          // IMAGES - Polished with proper spacing and rounded corners
          // ═══════════════════════════════════════════════════════════════
          img: ({ src, alt }) => {
            // Don't render img with empty src to avoid browser warning
            if (!src) return null;
            return (
              <span className="block my-5">
                <img
                  src={src}
                  alt={alt || ''}
                  className={cn(
                    "max-w-full h-auto rounded-xl",
                    "border border-border/40",
                    "shadow-sm"
                  )}
                  loading="lazy"
                />
                {alt && (
                  <span className="block mt-2 text-center text-sm text-muted-foreground">
                    {alt}
                  </span>
                )}
              </span>
            );
          },

          // ═══════════════════════════════════════════════════════════════
          // TEXT FORMATTING - Proper emphasis styling
          // ═══════════════════════════════════════════════════════════════
          strong: ({ children }) => (
            <strong className="font-semibold text-foreground">
              {children}
            </strong>
          ),
          em: ({ children }) => (
            <em className="italic text-foreground/90">
              {children}
            </em>
          ),
          del: ({ children }) => (
            <del className="line-through text-muted-foreground decoration-muted-foreground/50">
              {children}
            </del>
          ),

          // ═══════════════════════════════════════════════════════════════
          // TASK LISTS - Checkbox styling (GFM)
          // ═══════════════════════════════════════════════════════════════
          input: ({ checked, ...props }) => (
            <input
              type="checkbox"
              checked={checked}
              readOnly
              className={cn(
                "mr-2 h-4 w-4 rounded border-border",
                "accent-secondary cursor-default",
                "align-middle relative -top-[1px]"
              )}
              {...props}
            />
          ),

          // ═══════════════════════════════════════════════════════════════
          // RAW HTML SUPPORT (GFM allows raw HTML)
          // ═══════════════════════════════════════════════════════════════
          div: ({ children, style, className: divClassName, ...props }) => (
            <div 
              className={cn("text-sm text-foreground", divClassName)}
              style={style as React.CSSProperties}
              {...props}
            >
              {children}
            </div>
          ),
          span: ({ children, style, className: spanClassName, ...props }) => (
            <span 
              className={cn("text-foreground", spanClassName)}
              style={style as React.CSSProperties}
              {...props}
            >
              {children}
            </span>
          ),
        }}
      >
        {processedContent}
      </Streamdown>
    </div>
  );
});

UnifiedMarkdown.displayName = 'UnifiedMarkdown';
