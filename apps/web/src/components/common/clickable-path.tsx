'use client';

import { toSandboxAbsolutePath } from '@/features/files/api/runtime-files';
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
        'text-foreground cursor-pointer hover:underline',
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
 * Elements whose text belongs to something other than prose: code is code, and
 * a link already owns its own target. Path detection must not reach inside any
 * of them.
 */
const OPAQUE_TAG_NAMES = new Set(['code', 'pre', 'a']);

interface OpaqueProbeProps {
  children?: React.ReactNode;
  className?: string;
  /** hast element the markdown parser passes through to custom components. */
  node?: { tagName?: string };
}

/**
 * Is this element one whose subtree path detection must leave alone?
 *
 * Checking `el.type === 'code'` only catches the NATIVE tag. Both markdown
 * renderers replace `code`/`pre`/`a` with custom components, so the type is a
 * function there and the plain check missed every fence in the app. The tag
 * name survives on the `node` prop the parser forwards; fenced code also
 * carries `language-*` in `className`, which covers a renderer that drops
 * `node`.
 */
function isOpaqueElement(el: React.ReactElement<OpaqueProbeProps>): boolean {
  if (typeof el.type === 'string') return OPAQUE_TAG_NAMES.has(el.type);

  const tagName = el.props?.node?.tagName;
  if (typeof tagName === 'string' && OPAQUE_TAG_NAMES.has(tagName)) return true;

  const className = el.props?.className;
  return typeof className === 'string' && /(?:^|\s)language-/.test(className);
}

/**
 * Walk a React children tree and replace text nodes that contain file paths
 * with clickable versions. Skips children already inside <code>, <pre> or <a>.
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

    // React elements — recurse into children, but skip code/pre/a subtrees.
    if (React.isValidElement(child)) {
      const el = child as React.ReactElement<OpaqueProbeProps>;
      // Code and links handle their own text; rewriting their children turned
      // a fenced block's string into a React element, and `String(children)`
      // in MarkdownCode then rendered the literal `[object Object]`.
      if (isOpaqueElement(el)) {
        return child;
      }
      // A path already made clickable is finished. `li` wraps its children and
      // then the nested `p`/`td` component wraps them AGAIN, so the second pass
      // walked into the span the first pass produced and wrapped its text in a
      // second one — `role="button"` inside `role="button"`, two click handlers
      // on one path.
      if (el.type === ClickablePath) {
        return child;
      }
      // For custom (non-native) components, don't recurse if children is a
      // string that looks like a URL — those components handle their own
      // URL/path rendering.
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
