'use client';

import { DiffView } from '@/components/diff/diff-view';
import { CopyOverlay, HighlightedCode } from '@/components/markdown/code';
import { MarkdownFrontmatterCard, parseFrontmatter } from '@/components/markdown/markdown-frontmatter';
import { UnifiedMarkdown } from '@/components/markdown/unified-markdown';
import { DiffStat, STATUS_TEXT } from '@/components/ui/status';
import { WarningIcon as AlertTriangle, WarningCircleIcon as CircleAlert } from '@phosphor-icons/react';
import { useFilePreviewStore } from '@/stores/file-preview-store';
import { type LspDiagnostic, parseDiagnosticsFromToolOutput } from '@/stores/diagnostics-store';
import { type Diagnostic, getDiagnostics, type ToolPart } from '@/ui';
import { cn } from '@/lib/utils';
import { useToolCardFrame, useToolCardPad, useToolIndent } from './surface';
import { MD_FLUSH_CLASSES, useToolNavigation } from './infrastructure-preview';
import { partMetadata, partOutput } from './infrastructure-parts';

/**
 * A file's contents inside an expanded tool row, in the same card `bash` draws
 * around a command — so read / write / edit / bash all present code the one way.
 *
 * The indent comes from {@link useToolIndent}, and the `mt-1.5` seam rides with
 * it: both are the inline surface's business (see {@link ToolOutputCard}). On
 * the panel this card IS the disclosure body and the body already brings
 * `px-3 py-3`.
 *
 * `pr-11` is the shared reserve every floating copy button gets — `CopyOverlay`
 * pins its button at `top-3 right-3`, and without the reserve the first line of
 * a wrapped file ran underneath it.
 */
export function ToolCodeCard({
  code,
  language,
  className,
}: {
  code: string;
  language: string;
  className?: string;
}) {
  const indent = useToolIndent();
  const frame = useToolCardFrame();
  const pad = useToolCardPad();
  if (!code) return null;
  return (
    <div className={cn(indent && 'mt-1.5', indent, className)}>
      {/* Frame and pad are gated on the surface for the same reason the indent
          is: on the panel the row card is the frame and its body is the inset.
          See `useToolCardFrame`. */}
      <div className={cn('relative', frame)}>
        {/* The scroller sits INSIDE the overlay so the copy button stays pinned
            to the card while long content scrolls under it. */}
        <CopyOverlay code={code}>
          <div data-scrollable className={cn('max-h-96 overflow-auto', pad, 'pr-11')}>
            <HighlightedCode code={code} language={language} />
          </div>
        </CopyOverlay>
      </div>
    </div>
  );
}

/**
 * The markdown counterpart to {@link ToolCodeCard}: same chrome — trigger-aligned
 * indent, `border`/`bg-popover` card, copy overlay — with rendered prose instead
 * of a highlighted-source pane.
 *
 * YAML frontmatter (agent/skill headers, notes with metadata) goes through
 * `parseFrontmatter` so the `---` fences do not become a stray rule and a giant
 * heading. Content with none passes through unchanged.
 *
 * `variant="document"`: this reads as a stored file, not chat prose.
 */
export function ToolMarkdownCard({ code, className }: { code: string; className?: string }) {
  const indent = useToolIndent();
  const frame = useToolCardFrame();
  const pad = useToolCardPad();
  if (!code) return null;
  const { frontmatter, body } = parseFrontmatter(code);
  return (
    <div className={cn(indent && 'mt-1.5', indent, className)}>
      <div className={cn('relative', frame)}>
        <CopyOverlay code={code}>
          <div
            data-scrollable
            className={cn('max-h-96 overflow-auto', pad, 'pr-11', MD_FLUSH_CLASSES)}
          >
            {frontmatter && <MarkdownFrontmatterCard data={frontmatter} />}
            <UnifiedMarkdown content={body} trust="agent" variant="document" isStreaming={false} />
          </div>
        </CopyOverlay>
      </div>
    </div>
  );
}

export function InlineDiffView({
  oldValue,
  newValue,
  filename,
}: {
  oldValue: string;
  newValue: string;
  filename: string;
}) {
  if (!oldValue && !newValue) return null;
  return (
    <DiffView
      before={{ name: filename, contents: oldValue || '' }}
      after={{ name: filename, contents: newValue || '' }}
      layout="unified"
      hideFileHeader
    />
  );
}

/**
 * A frameless code pane, for code that is already inside someone else's card.
 *
 * `p-3` is the same inset every other mono body in the tool views carries
 * ({@link ToolCodeCard}, `bash`'s command and output panes); it used to be the
 * only one at `px-3 py-2`, which is the row/list inset, not the code one.
 */
export function ToolCode({ code, language }: { code: string; language: string }) {
  return (
    <div data-scrollable className="max-h-96 overflow-auto">
      <pre className="text-foreground/90 overflow-x-auto p-3 font-mono text-xs leading-[1.65] [&_code]:border-none [&_code]:bg-transparent [&_code]:p-0 [&_span]:border-none [&_span]:outline-none">
        <HighlightedCode code={code} language={language}>
          {code}
        </HighlightedCode>
      </pre>
    </div>
  );
}

export function getToolDiagnostics(part: ToolPart, filePath: string | undefined): Diagnostic[] {
  if (!filePath) return [];

  const output = partOutput(part);
  if (
    output &&
    (output.includes('<file_diagnostics>') || output.includes('<project_diagnostics>'))
  ) {
    const parsed = parseDiagnosticsFromToolOutput(output);

    let diags: LspDiagnostic[] | undefined;
    for (const [key, value] of Object.entries(parsed)) {
      if (key === filePath || key.endsWith('/' + filePath) || filePath.endsWith('/' + key)) {
        diags = value;
        break;
      }
    }

    if (!diags) {
      diags = Object.values(parsed).flat();
    }
    if (diags && diags.length > 0) {
      return diags
        .filter((d) => d.severity === 1 || d.severity === 2)
        .slice(0, 5)
        .map((d) => ({
          range: {
            start: { line: d.line, character: d.column },
            end: {
              line: d.endLine ?? d.line,
              character: d.endColumn ?? d.column,
            },
          },
          message: d.message,
          severity: d.severity,
        }));
    }
  }

  const metadata = partMetadata(part);
  return getDiagnostics(metadata.diagnostics as Record<string, Diagnostic[]> | undefined, filePath);
}

export function DiagnosticsDisplay({
  diagnostics,
  filePath,
}: {
  diagnostics: Diagnostic[];
  filePath?: string;
}) {
  const { enabled: navigationEnabled } = useToolNavigation();

  if (diagnostics.length === 0) return null;

  const handleClick = (d: Diagnostic) => {
    if (!filePath || !navigationEnabled) return;
    const targetLine = d.range.start.line + 1;
    useFilePreviewStore.getState().openPreview(filePath, targetLine);
  };

  return (
    <div className="space-y-1 px-2 pb-2">
      {diagnostics.map((d) => {
        const isError = d.severity === 1;
        const isWarning = d.severity === 2;
        return (
          <button
            type="button"
            key={`${d.range.start.line}:${d.range.start.character}:${d.severity ?? 0}:${d.message}`}
            disabled={!navigationEnabled || !filePath}
            className={cn(
              'group flex w-full items-start gap-1.5 text-left text-xs transition-colors',
              navigationEnabled && filePath ? 'cursor-pointer' : 'cursor-default opacity-70',
              isError && STATUS_TEXT.destructive,
              isWarning && STATUS_TEXT.warning,
              !isError && !isWarning && STATUS_TEXT.info,
            )}
            onClick={() => handleClick(d)}
          >
            {isError ? (
              <CircleAlert className="mt-0.5 size-3 shrink-0" />
            ) : (
              <AlertTriangle className="mt-0.5 size-3 shrink-0" />
            )}
            <span className="group-hover:underline">
              [{d.range.start.line + 1}:{d.range.start.character + 1}] {d.message}
            </span>
          </button>
        );
      })}
    </div>
  );
}

export function DiffChanges({ additions, deletions }: { additions: number; deletions: number }) {
  if (additions === 0 && deletions === 0) return null;

  return (
    <DiffStat
      additions={additions}
      deletions={deletions}
      className="ml-auto text-xs whitespace-nowrap"
    />
  );
}
