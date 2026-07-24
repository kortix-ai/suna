'use client';

import { toSandboxAbsolutePath } from '@/features/files/api/opencode-files';
import { cn } from '@/lib/utils';
import { splitTextByPaths } from '@/lib/utils/path-detection';
import { useFilePreviewStore } from '@/stores/file-preview-store';
import { getActivePanelSessionId, openFileInSessionPanel } from '@/stores/session-browser-store';
import React, { useCallback, useMemo } from 'react';

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

/**
 * Agents write workspace-relative paths (`docs/bio.md`) far more often than
 * absolute ones, so rejecting them made the common case unclickable — the user
 * got "Cannot open relative path" for a file that exists.
 *
 * `toSandboxAbsolutePath` is the same resolution the rest of the app already
 * applies to exactly these strings (`show-helpers.tsx`,
 * `show-content-renderer.tsx`, `file-content-renderer.tsx`): anything already
 * under an allowed sandbox root passes through, everything else anchors under
 * `/workspace`. This component was the one surface that rejected instead of
 * resolving.
 *
 * A path that resolves but doesn't exist is not this function's problem — the
 * viewer reports "couldn't be opened", the same as any dead absolute path, and
 * that beats refusing to try.
 */
export function resolveOpenablePath(filePath: string): string | null {
  const trimmed = filePath.trim();
  if (!trimmed) return null;
  return toSandboxAbsolutePath(trimmed);
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

      const resolved = resolveOpenablePath(filePath);
      if (!resolved) return;

      // Inside a session → the panel opens the file in its detail layer.
      // Elsewhere (no side-panel host) fall back to the app-level preview modal.
      const sessionId = getActivePanelSessionId();
      if (sessionId) {
        openFileInSessionPanel(sessionId, resolved, lineNumber);
        return;
      }
      openPreview(resolved, lineNumber);
    },
    [filePath, lineNumber, openPreview],
  );

  const title = lineNumber
    ? `${filePath}:${lineNumber}${column ? `:${column}` : ''} — Click to preview`
    : `${filePath} — Click to preview`;

  if (variant === 'terminal') {
    return (
      <span
        className={cn(
          'underline decoration-dotted decoration-1 underline-offset-2',
          'group/path inline-flex items-center gap-0.5 transition-colors',
          'cursor-pointer text-blue-400 hover:text-blue-300 dark:text-blue-400 dark:hover:text-blue-300',
          className,
        )}
        onClick={handleClick}
        title={title}
        role="button"
        tabIndex={0}
      >
        {children || filePath}
        {lineNumber && (
          <span className="text-blue-400/60">
            :{lineNumber}
            {column ? `:${column}` : ''}
          </span>
        )}
      </span>
    );
  }

  // Inline variant (for markdown text, etc.)
  return (
    <span
      className={cn(
        'group/path inline-flex items-center gap-0.5',
        'underline decoration-dotted decoration-1 underline-offset-2',
        'text-foreground cursor-pointer decoration-blue-400/40 hover:text-blue-600 hover:decoration-blue-500/70 dark:hover:text-blue-400',
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
        <span className="text-muted-foreground">
          :{lineNumber}
          {column ? `:${column}` : ''}
        </span>
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
export const TextWithPaths = React.memo<TextWithPathsProps>(
  ({ text, className, variant = 'inline' }) => {
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
  },
);

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
