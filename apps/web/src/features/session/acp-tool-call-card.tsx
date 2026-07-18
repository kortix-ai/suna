'use client';

import { acpToolCallToPart as acpToolCallToPartSdk, acpToolName as acpToolNameSdk, type AcpPlan, type AcpToolCall } from '@kortix/sdk';
import { HighlightedCode } from '@/components/markdown/unified-markdown';
import Loading from '@/components/ui/loading';
import { getLanguageFromExt } from '@/features/file-viewer/file-content-renderer';
import { cn } from '@/lib/utils';
import { useFilePreviewStore } from '@/stores/file-preview-store';
import { getDirectory, getFilename, getToolInfo, type ToolPart } from '@/ui';
import {
  BookOpen,
  Check,
  Cpu,
  FilePen,
  Glasses,
  Globe,
  Image as ImageIcon,
  Layers,
  List,
  ListTodo,
  ListTree,
  MessageCircle,
  Presentation,
  Scissors,
  Search,
  SquareKanban,
  Terminal,
  type LucideIcon,
} from 'lucide-react';
import { AcpTranscriptStep } from './acp-transcript-step';

/**
 * Canonical tool-renderer name for an ACP tool call. The classification lives
 * in the SDK (`@kortix/sdk`, harness-neutral) — this re-export gives the web
 * transcript's grouping code (`acp-turn-grouping.ts`, `acp-transcript-groups.tsx`)
 * ONE implementation to import from the card module, without a second copy.
 */
export const acpToolName = acpToolNameSdk;

/** `getToolInfo` speaks Lucide icon names as strings — this maps the ones an
 *  ACP harness can realistically emit onto components, falling back to `Cpu`
 *  (the same fallback identity `getToolInfo`'s own default branch uses). */
const TOOL_STEP_ICONS: Record<string, LucideIcon> = {
  glasses: Glasses,
  list: List,
  'list-tree': ListTree,
  search: Search,
  globe: Globe,
  image: ImageIcon,
  cpu: Cpu,
  presentation: Presentation,
  terminal: Terminal,
  'file-pen': FilePen,
  'check-square': ListTodo,
  'square-kanban': SquareKanban,
  'message-circle': MessageCircle,
  scissors: Scissors,
  layers: Layers,
  'book-open': BookOpen,
};

/** An ACP `diff`-typed tool content block — `{ path, oldText, newText }`.
 *  `oldText` is null for a brand-new file (Write). Only `path`/`newText` are
 *  rendered: the transcript shows WHAT the file says now (a file preview),
 *  never a diff (owner decision — diffs live in the Changes view). */
interface AcpDiffContent {
  path: string;
  oldText: string;
  newText: string;
}

/**
 * Subtitle of last resort, derived from the harness's own free-text title.
 * ACP titles are descriptive — "Read README.md", `Grep "pattern"` — so when
 * the structured input carries no path/pattern/query, the title's remainder
 * (minus the leading tool name) still identifies WHAT the call touched.
 * Returns undefined when the title says nothing beyond the bare tool name.
 */
function titleSubtitle(title: string, infoTitle: string, name: string): string | undefined {
  const trimmed = title.trim();
  if (!trimmed) return undefined;
  const lower = trimmed.toLowerCase();
  if (lower === infoTitle.toLowerCase() || lower === name.toLowerCase()) return undefined;
  if (lower.startsWith(`${infoTitle.toLowerCase()} `)) {
    const remainder = trimmed.slice(infoTitle.length).trim();
    return remainder || undefined;
  }
  return trimmed;
}

function firstAcpDiff(content: unknown[]): AcpDiffContent | null {
  for (const entry of content) {
    if (!isPlainRecord(entry) || entry.type !== 'diff') continue;
    const path = typeof entry.path === 'string' ? entry.path : '';
    const newText = typeof entry.newText === 'string' ? entry.newText : '';
    const oldText = typeof entry.oldText === 'string' ? entry.oldText : '';
    if (path || newText || oldText) return { path: path || 'file', oldText, newText };
  }
  return null;
}

/**
 * One ACP tool call as a transcript step (`AcpTranscriptStep` — the shared
 * `steps.tsx` idiom every activity row uses). The trigger reads
 * `Title  subtitle` (file path, pattern, command…) via the SAME
 * `getToolInfo` identity mapping the rest of the product renders tools
 * through; the body carries the call's real payload: a `$ command` echo for
 * shell, a `DiffView` for edit/write diffs, the output text otherwise.
 *
 * Two deliberate behaviors:
 * - A tool call that can say nothing beyond its own bare name — no
 *   file/pattern/command subtitle, no output, no diff, no error — renders
 *   NOTHING. A row reading just "Read" is noise, not information. (The step
 *   appears as soon as a `tool_call_update` delivers the missing input.)
 * - A shell step shows its command on the trigger row while closed; the
 *   moment it opens, the body's `$ command` echo takes over and the trigger
 *   copy hides (pure CSS off the trigger's `data-state`, no extra state).
 */
export function AcpToolCallCard({ tool, sessionId, compact = false }: { tool: AcpToolCall; sessionId: string; compact?: boolean }) {
  const openPreview = useFilePreviewStore((state) => state.openPreview);
  const part = acpToolCallToPart(tool, sessionId);
  const name = acpToolName(tool);
  const input = part.state.input ?? {};
  const info = getToolInfo(name, input);
  const running = part.state.status === 'running';

  const command = name === 'bash' && typeof input.command === 'string' ? input.command.trim() : '';
  const subtitle =
    (name === 'bash' ? command.split('\n')[0] || info.subtitle : info.subtitle) ??
    titleSubtitle(tool.title, info.title, name);
  const diff = firstAcpDiff(tool.content);
  // Edit/Write body: the file's text itself (a preview, never a diff) — the
  // diff block's post-state, or the raw write/edit input while the harness
  // hasn't reported content back yet.
  const fileText =
    diff?.newText ||
    (typeof input.content === 'string' ? input.content : '') ||
    (typeof input.new_string === 'string' ? input.new_string : '');
  const filePath =
    (typeof input.filePath === 'string' && input.filePath) || diff?.path || '';
  const output = (part.state.output ?? '').trim();
  const error = part.state.error?.trim();

  if (!subtitle && !fileText && !output && !error) return null;

  const Icon = TOOL_STEP_ICONS[info.icon] ?? Cpu;
  return (
    <AcpTranscriptStep
      icon={
        <Icon
          className={cn('text-muted-foreground/50 size-3.5', running && 'animate-pulse-heartbeat')}
        />
      }
      running={running}
      defaultOpen={!compact && part.state.status === 'error'}
      label={
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="shrink-0">{info.title}</span>
          {subtitle ? (
            <span
              className={cn(
                'text-muted-foreground/60 min-w-0 truncate font-mono',
                // Shell: the open body echoes the full command — the trigger
                // copy would be a duplicate, so it yields while open.
                name === 'bash' && 'group-data-[state=open]:hidden',
              )}
              title={subtitle}
            >
              {subtitle}
            </span>
          ) : null}
        </span>
      }
    >
      {command ? (
        <div className="text-foreground/80 font-mono text-xs break-words whitespace-pre-wrap">
          <span className="text-muted-foreground/50 select-none">$ </span>
          {command}
        </div>
      ) : null}
      {fileText ? (
        <AcpFilePreview
          path={filePath}
          text={fileText}
          onOpen={filePath ? () => openPreview(filePath) : undefined}
        />
      ) : error && !output ? (
        <div className="text-kortix-red/80 text-xs whitespace-pre-wrap">{error}</div>
      ) : output ? (
        <pre className="text-muted-foreground max-h-64 overflow-auto text-xs whitespace-pre-wrap">{output}</pre>
      ) : (
        <div className="text-muted-foreground/50 text-xs italic">
          {running ? 'No output yet' : 'No output'}
        </div>
      )}
    </AcpTranscriptStep>
  );
}

/**
 * File-content preview for edit/write tool bodies — the file's text in a
 * quiet `bg-popover` panel: a filename header (click opens the real file
 * preview) over flush syntax-highlighted content. Deliberately NOT a diff
 * (owner decision): the transcript answers "what does the file say", the
 * Changes view owns "what changed".
 */
function AcpFilePreview({
  path,
  text,
  onOpen,
}: {
  path: string;
  text: string;
  onOpen?: () => void;
}) {
  const filename = getFilename(path) || 'file';
  const directory = path ? getDirectory(path) : undefined;
  const header = (
    <>
      <span className="text-foreground min-w-0 truncate text-xs font-medium">{filename}</span>
      {directory ? (
        <span className="text-muted-foreground/60 min-w-0 truncate font-mono text-xs">
          {directory}
        </span>
      ) : null}
    </>
  );
  return (
    <div className="bg-popover overflow-hidden rounded-md border">
      {onOpen ? (
        <button
          type="button"
          onClick={onOpen}
          title={path}
          className="hover:bg-muted/50 flex w-full cursor-pointer items-center gap-1.5 border-b px-3 py-1.5 text-left transition-colors [&>span:first-child]:hover:underline [&>span:first-child]:hover:underline-offset-2"
        >
          {header}
        </button>
      ) : (
        <div className="flex items-center gap-1.5 border-b px-3 py-1.5">{header}</div>
      )}
      <div data-scrollable className="max-h-64 overflow-auto">
        <pre className="text-foreground/90 overflow-x-auto px-3 py-2 font-mono text-xs leading-[1.65] [&_code]:border-none [&_code]:bg-transparent [&_code]:p-0 [&_span]:border-none [&_span]:outline-none">
          <HighlightedCode code={text} language={getLanguageFromExt(filename)}>
            {text}
          </HighlightedCode>
        </pre>
      </div>
    </div>
  );
}

/**
 * Thin host adapter over the SDK's harness-neutral normalization: adds the
 * `ToolPart`-only host fields (`sessionID`, `messageID`, `type`) the SDK
 * deliberately omits, since it never invents a session id. `as ToolPart` is
 * the boundary cast — the SDK's `AcpNormalizedToolPart` and the web `ToolPart`
 * shape agree on everything except these host fields.
 */
export function acpToolCallToPart(tool: AcpToolCall, sessionId: string): ToolPart {
  const normalized = acpToolCallToPartSdk(tool);
  return {
    ...normalized,
    type: 'tool',
    sessionID: sessionId,
    messageID: `acp-tool-message:${tool.id}`,
  } as ToolPart;
}

/** The agent's plan as a transcript step — open by default (a live todo list
 *  is the one activity row worth reading at rest), with the same per-entry
 *  status ticks as before (green check / spinner / muted dot). */
export function AcpPlanCard({ plan }: { plan: AcpPlan }) {
  const count = plan.entries.length;
  if (count === 0) return null;
  const done = plan.entries.filter(
    (entry) => isPlainRecord(entry) && entry.status === 'completed',
  ).length;
  return (
    <AcpTranscriptStep
      icon={<ListTodo className="text-muted-foreground/50 size-3.5" />}
      defaultOpen
      label={
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="shrink-0">Plan</span>
          <span className="text-muted-foreground/60 min-w-0 truncate font-mono tabular-nums">
            {done}/{count} done
          </span>
        </span>
      }
    >
      <div className="space-y-1.5">
        {plan.entries.map((entry, index) => (
          <div key={index} className="text-muted-foreground flex items-center gap-2 text-sm">
            <PlanEntryStatusTick entry={entry} />
            <span className="min-w-0 flex-1">{planEntryText(entry)}</span>
          </div>
        ))}
      </div>
    </AcpTranscriptStep>
  );
}

/**
 * A wire plan entry is unknown-shaped — the SDK passes `update.entries`
 * straight through untyped (real ACP entries carry `{ status, content }` or
 * `{ status, title }`; the transcript tests exercise plain strings too), so
 * both the tick and the label below guard with `isPlainRecord` rather than
 * assuming a record shape.
 */
function PlanEntryStatusTick({ entry }: { entry: unknown }) {
  const status = isPlainRecord(entry) ? entry.status : undefined;
  if (status === 'completed') return <Check className="text-kortix-green size-3.5 shrink-0" />;
  if (status === 'in_progress') return <Loading className="size-3 shrink-0" />;
  return <span className="bg-muted-foreground/40 size-1.5 shrink-0 rounded-full" aria-hidden />;
}

function planEntryText(entry: unknown): string {
  if (isPlainRecord(entry)) {
    const value = entry.content ?? entry.title;
    if (typeof value === 'string') return value;
    if (value !== undefined) return String(value);
  }
  return String(entry);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
