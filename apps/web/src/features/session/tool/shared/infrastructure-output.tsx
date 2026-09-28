'use client';

import { CopyButton } from '@/components/markdown/copy-button';
import { UnifiedMarkdown } from '@/components/markdown/unified-markdown';
import { WarningCircleIcon as CircleAlert } from '@phosphor-icons/react';
import { STATUS_BG, STATUS_TEXT } from '@/components/ui/status';
import { ToolResultCard } from './result-card';
import { useToolCardFrame, useToolCardPad, useToolIndent } from './surface';
import { type ParsedJsonFailure } from './types';
import { ToolError } from '@/features/session/tool/tool-error';
import { formatRawOutput, looksLikeJsonPayload } from '@/features/session/tool/tool-output-format';
import { useTranslations } from '@/i18n/use-translations';
import { looksLikeMarkdown } from '@/lib/markdown-detect';
import { cn } from '@/lib/utils';
import { useMemo } from 'react';
import { MD_FLUSH_CLASSES } from './infrastructure-preview';
import { cleanErrorMessage, formatJsonFailureOutput, looksLikeError, parseJsonFailure } from './tool-outcome';

// ── Tool-outcome + JSON-failure parsing ────────────────────────────────────
export {
  cleanErrorMessage,
  formatJsonFailureOutput,
  isErrorOutput,
  looksLikeError,
  parseJsonFailure,
  partOutcome,
  type ToolOutcome,
} from './tool-outcome';

import { SidebarToggle as PanelRight } from '@/features/icon/icons/sidebar-toggle';
import {
  cleanErrorMessage,
  formatJsonFailureOutput,
  looksLikeError,
  parseJsonFailure,
  type ToolOutcome,
} from './tool-outcome';

export function JsonFailureOutputCard({
  failure,
}: {
  failure: ParsedJsonFailure;
  toolName?: string;
}) {
  const summary = cleanErrorMessage(failure.errorSummary);
  const detail = failure.nestedMessage ? cleanErrorMessage(failure.nestedMessage) : undefined;

  return (
    <div className="flex items-start gap-2.5 px-3 py-2.5 text-xs">
      <span
        className={cn(
          'mt-px flex size-5 shrink-0 items-center justify-center rounded-sm',
          STATUS_BG.destructive,
        )}
      >
        <CircleAlert className={cn('size-3.5', STATUS_TEXT.destructive)} />
      </span>
      <div className="min-w-0 flex-1 space-y-1">
        <p className="text-foreground/90 text-xs leading-relaxed text-pretty wrap-break-word">
          {summary}
        </p>
        {detail && detail !== summary && (
          <p className="text-muted-foreground text-xs leading-relaxed text-pretty wrap-break-word">
            {detail}
          </p>
        )}
        {failure.hint && (
          <p className="text-muted-foreground/80 text-xs leading-relaxed text-pretty wrap-break-word">
            {failure.hint.trim()}
          </p>
        )}
      </div>
      {typeof failure.status === 'number' && (
        <span className="text-muted-foreground/60 shrink-0 font-mono text-xs tabular-nums">
          {failure.status}
        </span>
      )}
    </div>
  );
}

export function ToolOutputFallback({
  output,
  isStreaming = false,
  toolName,
}: {
  output: string;
  isStreaming?: boolean;
  toolName?: string;
}) {
  const parsedJsonFailure = !isStreaming ? parseJsonFailure(output) : null;
  if (parsedJsonFailure) {
    return (
      <ToolResultCard>
        <JsonFailureOutputCard failure={parsedJsonFailure} toolName={toolName} />
      </ToolResultCard>
    );
  }

  const jsonFailure = !isStreaming ? formatJsonFailureOutput(output) : null;
  if (jsonFailure) {
    return <ToolError error={jsonFailure} toolName={toolName} />;
  }

  if (!isStreaming && looksLikeError(output)) {
    return <ToolError error={output} toolName={toolName} />;
  }

  if (looksLikeJsonPayload(output) || output.length > 4000) {
    return <RawOutputBlock output={output} />;
  }

  // Short, non-JSON output — a fetched page, a summary, an agent's prose. This
  // branch used to return a bare scroll div: no edge, no copy button, and no
  // indent, so a fetched article sat flush against the chain rail as loose text
  // while the very same content over 4000 characters got the full card. Same
  // shell either way now; only the length differs.
  return (
    <ToolOutputCard copyText={output}>
      <div className={cn('text-sm', MD_FLUSH_CLASSES)}>
        <UnifiedMarkdown content={output} trust="untrusted" isStreaming={isStreaming} />
      </div>
    </ToolOutputCard>
  );
}

/**
 * The shell every expanded tool output shares: hairlined card, copy button
 * pinned top-right, scrollable body, aligned to the row's label.
 *
 * One shell rather than per-branch chrome, because the alternative is what this
 * file already proved — the card gets added to whichever branch someone is
 * looking at, and the other paths quietly keep rendering naked text.
 */
function ToolOutputCard({ copyText, children }: { copyText?: string; children: React.ReactNode }) {
  const indent = useToolIndent();
  const frame = useToolCardFrame();
  const pad = useToolCardPad();

  return (
    <div
      className={cn(
        'relative',
        // Frame and inset are the panel's business too: on the panel the row
        // card is already the frame, so drawing a second one around the body
        // is the triple-nesting the gate filed. See `useToolCardFrame`.
        frame,
        // The seam and the indent are ONE inline-surface concern, so they are
        // gated together. Inline, the card hangs under a trigger row and needs
        // both: 6px of air and the row's 22px text column (this card used to
        // hardcode `ml-7`, 28px, against a `gap-3` the row class does not
        // have). On the panel the card IS the disclosure body, which already
        // supplies `px-3 py-3` — a top margin there is double-spacing, 18px
        // over 12px at the bottom.
        indent && 'mt-1.5',
        indent,
      )}
    >
      {/* Floated rather than in a header bar: a bar would cost a row of height
		      on every output block, and the button reads clearly against the
		      surface on its own. `pr-11` on the body keeps the first line from
		      running under it — one reserve value for every floating copy in the
		      tool views (`bash`'s command/output panes and `ToolCodeCard` use the
		      same one). */}
      {copyText && (
        <CopyButton
          code={copyText}
          className="text-muted-foreground/60 hover:text-foreground absolute top-1 right-1 z-10"
        />
      )}
      <div data-scrollable className={cn('max-h-96 overflow-auto', pad, 'pr-11')}>
        {children}
      </div>
    </div>
  );
}

/**
 * Raw tool output as its own object: a muted, hairlined card with a copy
 * button pinned top-right.
 *
 * Bare `<pre>` on the page had no edge, so a wall of output bled into the step
 * around it and there was no way to get the text out except selecting it by
 * hand. The card gives it a boundary; the copy button gives it an exit.
 *
 * Markdown renders as markdown. Agents routinely answer in markdown, and
 * showing a reader `## Heading` and `**bold**` as literal punctuation is
 * showing them the transport instead of the message. Detection is conservative
 * (`looksLikeMarkdown`) — anything short of unambiguous syntax stays in the
 * monospace block, which is the right home for logs, stack traces, and JSON.
 *
 * Copy always sends the FULL original output, never the truncated or
 * pretty-printed `text` — the copy button is how you get at the part the cap
 * hid, so handing back the visible slice would defeat it.
 */
export function RawOutputBlock({ output, maxChars = 2000 }: { output: string; maxChars?: number }) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const { text, truncatedChars } = useMemo(
    () => formatRawOutput(output, maxChars),
    [output, maxChars],
  );
  const isMarkdown = useMemo(() => looksLikeMarkdown(text), [text]);

  return (
    <ToolOutputCard copyText={output}>
      {isMarkdown ? (
        <div className={cn('text-sm', MD_FLUSH_CLASSES)}>
          <UnifiedMarkdown content={text} trust="untrusted" />
        </div>
      ) : (
        <pre className="text-muted-foreground font-mono text-xs leading-relaxed wrap-break-word whitespace-pre-wrap">
          {text}
        </pre>
      )}
      {truncatedChars > 0 && (
        <div className="text-muted-foreground/40 mt-2 text-xs">
          +{truncatedChars.toLocaleString()} {tI18nComplete.raw('text6d0123a90793')}
        </div>
      )}
    </ToolOutputCard>
  );
}
