'use client';

import React, { useCallback, useMemo } from 'react';
import { cn } from '@/lib/utils';
import { splitTextByPaths } from '@/lib/utils/path-detection';
import { useFilePreviewStore } from '@/stores/file-preview-store';
import {
  getActivePanelSessionId,
  openFileInSessionPanel,
} from '@/stores/session-browser-store';
import { toast } from '@/lib/toast';

// ---------------------------------------------------------------------------
// Path validation
// ---------------------------------------------------------------------------

/**
 * Check if a file path is absolute (starts with /).
 * Relative paths are rejected — they resolve to wrong locations in the sandbox
 * and would show empty file content to the user.
 */
function isAbsolutePath(filePath: string): boolean {
  return filePath.startsWith('/');
}

// ---------------------------------------------------------------------------
// ClickablePath — renders a single file path as a clickable element
// ---------------------------------------------------------------------------

interface ClickablePathProps {
  /** The file path to display and link */
  filePath: string;
  /** Display text (defaults to filePath) */
  children?: React.ReactNode;
  /** Optional line number for navigation */
  lineNumber?: number;
  /** Optional column number */
  column?: number;
  /** Additional className */
  className?: string;
  /** Variant: 'inline' for inline text, 'terminal' for terminal/pre output */
  variant?: 'inline' | 'terminal';
}

export function ClickablePath({
  filePath,
  children,
  lineNumber,
  column,
  className,
  variant = 'inline',
}: ClickablePathProps) {
  const openPreview = useFilePreviewStore((s) => s.openPreview);

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();

      // Reject relative paths — they resolve to wrong locations and show empty files
      if (!isAbsolutePath(filePath)) {
        toast.error(`Cannot open relative path: ${filePath}`);
        return;
      }

      // Inside a session → reveal the file in the side-panel Files tab, mirroring
      // how a localhost link opens the Browser tab. Elsewhere (no side panel host)
      // fall back to the in-place preview modal.
      const sessionId = getActivePanelSessionId();
      if (sessionId) {
        openFileInSessionPanel(sessionId, filePath, lineNumber);
        return;
      }
      openPreview(filePath, lineNumber);
    },
    [filePath, lineNumber, openPreview],
  );

  const isRelative = !isAbsolutePath(filePath);

  const title = isRelative
    ? `${filePath} — Relative path (cannot open)`
    : lineNumber
      ? `${filePath}:${lineNumber}${column ? `:${column}` : ''} — Click to preview`
      : `${filePath} — Click to preview`;

  if (variant === 'terminal') {
    return (
      <span
        className={cn(
          'underline decoration-dotted decoration-1 underline-offset-2',
          'transition-colors inline-flex items-center gap-0.5 group/path',
          isRelative
            ? 'text-muted-foreground/70 cursor-not-allowed'
            : 'cursor-pointer text-blue-400 hover:text-blue-300 dark:text-blue-400 dark:hover:text-blue-300',
          className,
        )}
        onClick={handleClick}
        title={title}
        role="button"
        tabIndex={0}
      >
        {children || filePath}
        {lineNumber && (
          <span className="text-blue-400/60">:{lineNumber}{column ? `:${column}` : ''}</span>
        )}
      </span>
    );
  }

  // Inline variant (for markdown text, etc.)
  return (
    <span
      className={cn(
        'inline-flex items-center gap-0.5 group/path',
        'underline decoration-dotted underline-offset-2 decoration-1',
        isRelative
          ? 'text-muted-foreground/70 decoration-muted-foreground/30 cursor-not-allowed'
          : 'cursor-pointer text-foreground hover:text-blue-600 dark:hover:text-blue-400 decoration-blue-400/40 hover:decoration-blue-500/70',
        'transition-colors',
        className,
      )}
      onClick={handleClick}
      title={title}
      role="button"
      tabIndex={0}
    >
      {children || filePath}
      {lineNumber && (
        <span className="text-muted-foreground">:{lineNumber}{column ? `:${column}` : ''}</span>
      )}
    </span>
  );
}

// ---------------------------------------------------------------------------
// TextWithPaths — renders a block of text with all file paths clickable
// ---------------------------------------------------------------------------

interface TextWithPathsProps {
  /** The raw text to scan for file paths */
  text: string;
  /** Additional className for the container span */
  className?: string;
  /** Variant passed to ClickablePath */
  variant?: 'inline' | 'terminal';
}

/**
 * Renders a string of text with all detected file paths made clickable.
 * Paths are rendered using ClickablePath, which opens the file preview on click.
 */
export const TextWithPaths = React.memo<TextWithPathsProps>(({ text, className, variant = 'inline' }) => {
  const segments = useMemo(() => splitTextByPaths(text), [text]);

  // If no paths found, return plain text
  if (segments.length === 1 && segments[0].type === 'text') {
    return <>{text}</>;
  }

  return (
    <span className={className}>
      {segments.map((seg, i) => {
        if (seg.type === 'text') {
          return <React.Fragment key={i}>{seg.value}</React.Fragment>;
        }
        return (
          <ClickablePath
            key={i}
            filePath={seg.filePath!}
            lineNumber={seg.lineNumber}
            column={seg.column}
            variant={variant}
          >
            {seg.filePath}
          </ClickablePath>
        );
      })}
    </span>
  );
});

TextWithPaths.displayName = 'TextWithPaths';

// ---------------------------------------------------------------------------
// PreWithPaths — renders a <pre> block with file paths clickable
// ---------------------------------------------------------------------------

interface PreWithPathsProps {
  /** The raw text content */
  text: string;
  /** Additional className for the <pre> element */
  className?: string;
}

/**
 * Renders a pre-formatted text block (like terminal output) with file paths
 * made clickable. Processes line by line for efficiency.
 */
export const PreWithPaths = React.memo<PreWithPathsProps>(({ text, className }) => {
  const lines = useMemo(() => text.split('\n'), [text]);

  return (
    <pre className={className}>
      {lines.map((line, lineIdx) => (
        <React.Fragment key={lineIdx}>
          {lineIdx > 0 && '\n'}
          <TextWithPaths text={line} variant="terminal" />
        </React.Fragment>
      ))}
    </pre>
  );
});

PreWithPaths.displayName = 'PreWithPaths';

// ---------------------------------------------------------------------------
// wrapChildrenWithPaths — recursively process React children to detect paths
// ---------------------------------------------------------------------------

/**
 * Walk a React children tree and replace text nodes that contain file paths
 * with clickable versions. Skips children already inside <code> or <a> elements.
 */
export function wrapChildrenWithPaths(
  children: React.ReactNode,
  variant: 'inline' | 'terminal' = 'inline',
): React.ReactNode {
  return React.Children.map(children, (child) => {
    // String text nodes — scan for paths
    if (typeof child === 'string') {
      const segments = splitTextByPaths(child);
      if (segments.length === 1 && segments[0].type === 'text') {
        return child; // No paths found
      }
      return (
        <>
          {segments.map((seg, i) => {
            if (seg.type === 'text') {
              return <React.Fragment key={i}>{seg.value}</React.Fragment>;
            }
            return (
              <ClickablePath
                key={i}
                filePath={seg.filePath!}
                lineNumber={seg.lineNumber}
                column={seg.column}
                variant={variant}
              >
                {seg.filePath}
              </ClickablePath>
            );
          })}
        </>
      );
    }

    // React elements — recurse into children, but skip <code> and <a>
    if (React.isValidElement(child)) {
      const el = child as React.ReactElement<{ children?: React.ReactNode }>;
      // Don't process children of code/a elements (they have their own handling)
      if (
        typeof el.type === 'string' &&
        (el.type === 'code' || el.type === 'a' || el.type === 'pre')
      ) {
        return child;
      }
      // For custom (non-native) components (e.g. Streamdown's code/a/pre
      // overrides), don't recurse if children is a string that looks like a
      // URL — those components handle their own URL/path rendering.
      if (typeof el.type !== 'string' && typeof el.props.children === 'string') {
        if (/^[a-z][a-z0-9+.-]*:\/\//i.test(el.props.children.trim())) {
          return child;
        }
      }
      // Recurse
      if (el.props.children) {
        return React.cloneElement(el, {
          ...el.props,
          children: wrapChildrenWithPaths(el.props.children, variant),
        });
      }
    }

    return child;
  });
}
