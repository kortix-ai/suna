'use client';

/**
 * One agent tool call, rendered as a tidy collapsible card: an icon + humanized
 * name + a one-line summary, a live status indicator, and (expanded) a
 * per-tool body built from `toolViewModel` — typed shapes for web/image
 * search, shell, file read/write/edit, grep/glob search, task, todowrite,
 * and question, with a pretty-JSON `generic` fallback for everything else.
 *
 * Takes a normalized `ToolView` from `@kortix/sdk/turns` (`classifyPart`'s
 * tool variant) instead of the raw wire tool part — status is already mapped
 * to 'pending'|'running'|'done'|'error' (including router/executor tools like
 * `web_search` that report `state.status: "completed"` but wrap a failure in
 * their JSON output body — `ToolView` reclassifies those as `'error'` so they
 * never render as a quiet success), and the icon comes from `toolInfo`'s
 * `category` (a real registry keyed on tool name) instead of string-sniffing
 * the tool name (`t.includes('bash')` etc.).
 */

import { Badge } from '@/components/ui/badge';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';
import {
  type ToolCategory,
  type ToolView,
  type ToolViewModel,
  toolInfo,
  toolViewModel,
} from '@kortix/sdk/turns';
import {
  Bot,
  Check,
  CheckSquare,
  ChevronRight,
  CircleAlert,
  FileText,
  FolderSearch,
  Globe,
  Loader2,
  type LucideIcon,
  Pencil,
  Search,
  SquareTerminal,
  Wrench,
} from 'lucide-react';

const CATEGORY_ICON: Record<ToolCategory, LucideIcon> = {
  shell: SquareTerminal,
  files: FileText,
  edit: Pencil,
  search: FolderSearch,
  web: Globe,
  task: Bot,
  other: Wrench,
};

function StatusDot({ status }: { status: ToolView['status'] }) {
  if (status === 'running' || status === 'pending')
    return <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />;
  if (status === 'error') return <CircleAlert className="size-3.5 shrink-0 text-destructive" />;
  return <Check className="size-3.5 shrink-0 text-emerald-500" />;
}

/** One-line summary shown next to the tool title, collapsed. */
function summaryFor(vm: ToolViewModel): string {
  switch (vm.kind) {
    case 'web-search':
      return vm.query;
    case 'shell':
      return vm.command;
    case 'file-read':
    case 'file-write':
    case 'file-edit':
      return vm.path;
    case 'search':
      return vm.pattern;
    case 'task':
      return vm.description;
    case 'todo':
      return vm.items.length > 0 ? `${vm.items.length} item${vm.items.length === 1 ? '' : 's'}` : '';
    case 'question':
      return vm.questions[0]?.question ?? '';
    case 'generic':
      return '';
  }
}

function OutputBlock({ text, isError }: { text: string; isError?: boolean }) {
  return (
    <pre
      className={cn(
        'max-h-72 overflow-auto rounded-md bg-muted/50 p-2 font-mono text-[0.7rem] leading-relaxed scrollbar-thin',
        isError ? 'text-destructive' : 'text-foreground/80',
      )}
    >
      {text.slice(0, 6000)}
    </pre>
  );
}

function WebSearchBody({ vm }: { vm: Extract<ToolViewModel, { kind: 'web-search' }> }) {
  if (vm.error) {
    return (
      <div className="flex items-start gap-2 rounded-md border border-destructive/20 bg-destructive/5 p-2 text-xs text-destructive">
        <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
        <span>Web search failed: {vm.error}</span>
      </div>
    );
  }
  if (!vm.results || vm.results.length === 0) {
    return <p className="text-xs text-muted-foreground">No results.</p>;
  }
  return (
    <div className="space-y-2">
      {vm.answer && <p className="text-xs text-foreground/80">{vm.answer}</p>}
      <ul className="space-y-1.5">
        {vm.results.map((r, i) => (
          <li key={`${r.url}-${i}`} className="min-w-0">
            <a
              href={r.url}
              target="_blank"
              rel="noreferrer noopener"
              className="block truncate text-xs font-medium text-primary hover:underline"
            >
              {r.title || r.url}
            </a>
            <div className="truncate text-[0.7rem] text-muted-foreground">{r.url}</div>
            {r.snippet && (
              <p className="mt-0.5 line-clamp-2 text-xs text-foreground/70">{r.snippet}</p>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function ShellBody({ vm }: { vm: Extract<ToolViewModel, { kind: 'shell' }>; isError: boolean }) {
  return (
    <div className="space-y-2">
      {vm.command && (
        <pre className="overflow-auto rounded-md bg-muted/50 p-2 font-mono text-[0.7rem] leading-relaxed text-foreground/80 scrollbar-thin">
          $ {vm.command}
        </pre>
      )}
      {typeof vm.exitCode === 'number' && vm.exitCode !== 0 && (
        <Badge variant="destructive" className="text-[0.65rem]">
          exit {vm.exitCode}
        </Badge>
      )}
      {vm.stdout && <OutputBlock text={vm.stdout} />}
    </div>
  );
}

function FilePreviewBody({ path, preview }: { path: string; preview?: string }) {
  return (
    <div className="space-y-1.5">
      {path && <div className="truncate font-mono text-[0.7rem] text-muted-foreground">{path}</div>}
      {preview && <OutputBlock text={preview} />}
    </div>
  );
}

function FileEditBody({ vm }: { vm: Extract<ToolViewModel, { kind: 'file-edit' }> }) {
  return (
    <div className="space-y-1.5">
      {vm.path && (
        <div className="truncate font-mono text-[0.7rem] text-muted-foreground">{vm.path}</div>
      )}
      {vm.diff && vm.diff.length > 0 ? (
        <pre className="max-h-72 overflow-auto rounded-md bg-muted/50 p-2 font-mono text-[0.7rem] leading-relaxed scrollbar-thin">
          {vm.diff.slice(0, 400).map((line, i) => (
            <div
              key={i}
              className={cn(
                'whitespace-pre-wrap',
                line.type === 'added' && 'bg-emerald-500/10 text-emerald-500',
                line.type === 'removed' && 'bg-destructive/10 text-destructive',
                line.type === 'unchanged' && 'text-foreground/60',
              )}
            >
              {line.type === 'added' ? '+ ' : line.type === 'removed' ? '- ' : '  '}
              {line.text}
            </div>
          ))}
        </pre>
      ) : null}
    </div>
  );
}

function SearchBody({ vm }: { vm: Extract<ToolViewModel, { kind: 'search' }> }) {
  if (!vm.matches || vm.matches.length === 0) {
    return <p className="text-xs text-muted-foreground">No matches.</p>;
  }
  return (
    <ul className="max-h-72 space-y-1 overflow-auto font-mono text-[0.7rem] text-foreground/80 scrollbar-thin">
      {vm.matches.map((m, i) => (
        <li key={i} className="truncate">
          <span className="text-muted-foreground">{m.path}</span>
          {typeof m.line === 'number' && <span className="text-muted-foreground">:{m.line}</span>}
          {m.content && <span className="ml-1.5">{m.content}</span>}
        </li>
      ))}
    </ul>
  );
}

function TaskBody({ vm }: { vm: Extract<ToolViewModel, { kind: 'task' }> }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-xs text-foreground/80">
      <span>{vm.description}</span>
      {vm.agent && (
        <Badge variant="secondary" className="text-[0.65rem]">
          {vm.agent}
        </Badge>
      )}
    </div>
  );
}

function TodoBody({ vm }: { vm: Extract<ToolViewModel, { kind: 'todo' }> }) {
  if (vm.items.length === 0) return null;
  return (
    <ul className="space-y-1">
      {vm.items.map((item, i) => (
        <li key={i} className="flex items-start gap-2 text-xs">
          <CheckSquare
            className={cn(
              'mt-0.5 size-3.5 shrink-0',
              item.status === 'completed' ? 'text-emerald-500' : 'text-muted-foreground',
            )}
          />
          <span
            className={cn(
              item.status === 'completed' && 'text-muted-foreground line-through',
              item.status !== 'completed' && 'text-foreground/80',
            )}
          >
            {item.content}
          </span>
        </li>
      ))}
    </ul>
  );
}

function QuestionBody({ vm }: { vm: Extract<ToolViewModel, { kind: 'question' }> }) {
  if (vm.questions.length === 0) return null;
  return (
    <div className="space-y-2">
      {vm.questions.map((q, i) => (
        <div key={i} className="space-y-1">
          <p className="text-xs font-medium text-foreground/80">{q.question}</p>
          {q.options.length > 0 && (
            <ul className="space-y-0.5 pl-3 text-xs text-muted-foreground">
              {q.options.map((o, oi) => (
                <li key={oi}>• {o.label}</li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </div>
  );
}

function GenericBody({ vm }: { vm: Extract<ToolViewModel, { kind: 'generic' }>; isError: boolean }) {
  return (
    <div className="space-y-2">
      {vm.inputPretty && (
        <pre className="max-h-48 overflow-auto rounded-md bg-muted/50 p-2 font-mono text-[0.7rem] leading-relaxed text-muted-foreground scrollbar-thin">
          {vm.inputPretty}
        </pre>
      )}
      {vm.outputPretty && <OutputBlock text={vm.outputPretty} />}
    </div>
  );
}

/** Renders the expanded body for a `ToolViewModel`, one branch per kind —
 *  the switch is exhaustive so a new kind fails typecheck here instead of
 *  silently falling through to nothing. */
function ToolBody({ vm, isError }: { vm: ToolViewModel; isError: boolean }) {
  switch (vm.kind) {
    case 'web-search':
      return <WebSearchBody vm={vm} />;
    case 'shell':
      return <ShellBody vm={vm} isError={isError} />;
    case 'file-read':
    case 'file-write':
      return <FilePreviewBody path={vm.path} preview={vm.preview} />;
    case 'file-edit':
      return <FileEditBody vm={vm} />;
    case 'search':
      return <SearchBody vm={vm} />;
    case 'task':
      return <TaskBody vm={vm} />;
    case 'todo':
      return <TodoBody vm={vm} />;
    case 'question':
      return <QuestionBody vm={vm} />;
    case 'generic':
      return <GenericBody vm={vm} isError={isError} />;
    default: {
      const _exhaustive: never = vm;
      return _exhaustive;
    }
  }
}

export function ToolCall({ tool }: { tool: ToolView }) {
  const { category } = toolInfo(tool.name);
  const Icon = CATEGORY_ICON[category] ?? Wrench;
  const vm = toolViewModel(tool);
  const summary = summaryFor(vm);
  const isError = tool.status === 'error';

  const hasDetail =
    vm.kind !== 'generic' ||
    !!vm.inputPretty ||
    !!vm.outputPretty ||
    !!summary;

  return (
    <Collapsible
      className={cn(
        'rounded-lg border bg-card/50',
        isError ? 'border-destructive/30 bg-destructive/[0.03]' : 'border-border',
      )}
    >
      <CollapsibleTrigger
        disabled={!hasDetail}
        className="group flex w-full items-center gap-2 px-2.5 py-2 text-left disabled:cursor-default"
      >
        <Icon
          className={cn('size-3.5 shrink-0', isError ? 'text-destructive' : 'text-muted-foreground')}
        />
        <span
          className={cn(
            'shrink-0 text-xs font-medium',
            isError ? 'text-destructive' : 'text-foreground',
          )}
        >
          {tool.title}
        </span>
        {summary && (
          <span className="truncate font-mono text-xs text-muted-foreground">{summary}</span>
        )}
        <span className="ml-auto flex items-center gap-1.5">
          <StatusDot status={tool.status} />
          {hasDetail && (
            <ChevronRight className="size-3.5 text-muted-foreground transition-transform group-data-[state=open]:rotate-90" />
          )}
        </span>
      </CollapsibleTrigger>
      {hasDetail && (
        <CollapsibleContent>
          <div className="border-t border-border px-2.5 py-2">
            <ToolBody vm={vm} isError={isError} />
          </div>
        </CollapsibleContent>
      )}
    </Collapsible>
  );
}
