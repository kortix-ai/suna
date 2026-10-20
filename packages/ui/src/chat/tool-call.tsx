'use client';

/**
 * One agent tool call as a collapsible card: a category icon, the tool title,
 * a one-line summary, a live status glyph and, expanded, a body built from
 * `toolViewModel` (web search, shell, file read/write/edit, grep/glob, task,
 * todo, question, and a pretty-JSON `generic` fallback).
 *
 * Takes the normalized `ToolView` from `@kortix/sdk`: status is already
 * 'pending' | 'running' | 'done' | 'error' (a router tool that reports
 * `completed` around a failure body is `error`), and the icon comes from the
 * `toolInfo` registry, not from sniffing the tool name.
 */

import {
  CaretRightIcon,
  CheckIcon,
  CheckSquareIcon,
  FileTextIcon,
  GlobeIcon,
  type Icon,
  MagnifyingGlassIcon,
  PencilSimpleIcon,
  RobotIcon,
  TerminalWindowIcon,
  WarningCircleIcon,
  WrenchIcon,
} from '@phosphor-icons/react';
import { type ToolCategory, type ToolView, type ToolViewModel, toolInfo, toolViewModel } from '@kortix/sdk';

import { Badge } from '../components/ui/badge';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../components/ui/collapsible';
import Loading from '../components/ui/loading';
import { cn } from '../lib/utils';
import { type ChatStrings, useUiStrings } from '../providers/ui-provider';

const CATEGORY_ICON: Record<ToolCategory, Icon> = {
  shell: TerminalWindowIcon,
  files: FileTextIcon,
  edit: PencilSimpleIcon,
  search: MagnifyingGlassIcon,
  web: GlobeIcon,
  task: RobotIcon,
  other: WrenchIcon,
};

const PRE = 'bg-muted scrollbar-thin overflow-auto rounded-md p-2 font-mono text-xs leading-relaxed';

function StatusGlyph({ status }: { status: ToolView['status'] }) {
  if (status === 'running' || status === 'pending')
    return <Loading variant="ring" className="text-muted-foreground size-3.5 shrink-0" />;
  if (status === 'error') return <WarningCircleIcon weight="fill" className="text-destructive size-3.5 shrink-0" />;
  return <CheckIcon className="text-kortix-green size-3.5 shrink-0" />;
}

/** One-line summary next to the title while collapsed. */
function summaryFor(vm: ToolViewModel, t: ChatStrings): string {
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
      return vm.items.length > 0 ? t.todoItems(vm.items.length) : '';
    case 'question':
      return vm.questions[0]?.question ?? '';
    case 'generic':
      return '';
  }
}

function OutputBlock({ text }: { text: string }) {
  return <pre className={cn(PRE, 'text-foreground max-h-72')}>{text.slice(0, 6000)}</pre>;
}

function PathLine({ path }: { path: string }) {
  return path ? <div className="text-muted-foreground truncate font-mono text-xs">{path}</div> : null;
}

function WebSearchBody({ vm }: { vm: Extract<ToolViewModel, { kind: 'web-search' }> }) {
  const t = useUiStrings().chat;
  if (vm.error) {
    return (
      <div className="bg-destructive/10 text-foreground flex items-start gap-2 rounded-md p-2 text-xs">
        <WarningCircleIcon weight="fill" className="text-destructive mt-0.5 size-3.5 shrink-0" />
        <span>{t.webSearchFailed(vm.error)}</span>
      </div>
    );
  }
  if (!vm.results || vm.results.length === 0) {
    return <p className="text-muted-foreground text-xs">{t.noResults}</p>;
  }
  return (
    <div className="space-y-2">
      {vm.answer && <p className="text-foreground text-xs">{vm.answer}</p>}
      <ul className="space-y-1.5">
        {vm.results.map((r, i) => (
          <li key={`${r.url}-${i}`} className="min-w-0">
            <a
              href={r.url}
              target="_blank"
              rel="noreferrer noopener"
              className="text-foreground block truncate text-xs font-medium hover:underline"
            >
              {r.title || r.url}
            </a>
            <div className="text-muted-foreground truncate text-xs">{r.url}</div>
            {r.snippet && <p className="text-muted-foreground mt-0.5 line-clamp-2 text-xs">{r.snippet}</p>}
          </li>
        ))}
      </ul>
    </div>
  );
}

function ShellBody({ vm }: { vm: Extract<ToolViewModel, { kind: 'shell' }> }) {
  return (
    <div className="space-y-2">
      {vm.command && <pre className={cn(PRE, 'text-foreground')}>$ {vm.command}</pre>}
      {typeof vm.exitCode === 'number' && vm.exitCode !== 0 && (
        <Badge variant="destructive">exit {vm.exitCode}</Badge>
      )}
      {vm.stdout && <OutputBlock text={vm.stdout} />}
    </div>
  );
}

function FilePreviewBody({ path, preview }: { path: string; preview?: string }) {
  return (
    <div className="space-y-1.5">
      <PathLine path={path} />
      {preview && <OutputBlock text={preview} />}
    </div>
  );
}

function FileEditBody({ vm }: { vm: Extract<ToolViewModel, { kind: 'file-edit' }> }) {
  return (
    <div className="space-y-1.5">
      <PathLine path={vm.path} />
      {vm.diff && vm.diff.length > 0 ? (
        <pre className={cn(PRE, 'max-h-72')}>
          {vm.diff.slice(0, 400).map((line, i) => (
            <div
              key={i}
              className={cn(
                'whitespace-pre-wrap',
                line.type === 'added' && 'bg-kortix-green/15 text-foreground',
                line.type === 'removed' && 'bg-destructive/10 text-foreground',
                line.type === 'unchanged' && 'text-muted-foreground',
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
  const t = useUiStrings().chat;
  if (!vm.matches || vm.matches.length === 0) {
    return <p className="text-muted-foreground text-xs">{t.noMatches}</p>;
  }
  return (
    <ul className="text-foreground scrollbar-thin max-h-72 space-y-1 overflow-auto font-mono text-xs">
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
    <div className="text-foreground flex flex-wrap items-center gap-1.5 text-xs">
      <span>{vm.description}</span>
      {vm.agent && <Badge variant="secondary">{vm.agent}</Badge>}
    </div>
  );
}

function TodoBody({ vm }: { vm: Extract<ToolViewModel, { kind: 'todo' }> }) {
  if (vm.items.length === 0) return null;
  return (
    <ul className="space-y-1">
      {vm.items.map((item, i) => {
        const done = item.status === 'completed';
        return (
          <li key={i} className="flex items-start gap-2 text-xs">
            <CheckSquareIcon
              weight={done ? 'fill' : undefined}
              className={cn('mt-0.5 size-3.5 shrink-0', done ? 'text-kortix-green' : 'text-muted-foreground')}
            />
            <span className={done ? 'text-muted-foreground line-through' : 'text-foreground'}>{item.content}</span>
          </li>
        );
      })}
    </ul>
  );
}

function QuestionBody({ vm }: { vm: Extract<ToolViewModel, { kind: 'question' }> }) {
  if (vm.questions.length === 0) return null;
  return (
    <div className="space-y-2">
      {vm.questions.map((q, i) => (
        <div key={i} className="space-y-1">
          <p className="text-foreground text-xs font-medium">{q.question}</p>
          {q.options.length > 0 && (
            <ul className="text-muted-foreground list-disc space-y-0.5 pl-4 text-xs">
              {q.options.map((o, oi) => (
                <li key={oi}>{o.label}</li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </div>
  );
}

function GenericBody({ vm }: { vm: Extract<ToolViewModel, { kind: 'generic' }> }) {
  return (
    <div className="space-y-2">
      {vm.inputPretty && <pre className={cn(PRE, 'text-muted-foreground max-h-48')}>{vm.inputPretty}</pre>}
      {vm.outputPretty && <OutputBlock text={vm.outputPretty} />}
    </div>
  );
}

/** The expanded body, one branch per kind: a new kind fails typecheck here. */
function ToolBody({ vm }: { vm: ToolViewModel }) {
  switch (vm.kind) {
    case 'web-search':
      return <WebSearchBody vm={vm} />;
    case 'shell':
      return <ShellBody vm={vm} />;
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
      return <GenericBody vm={vm} />;
    default: {
      const exhaustive: never = vm;
      return exhaustive;
    }
  }
}

export function ToolCall({ tool }: { tool: ToolView }) {
  const Glyph = CATEGORY_ICON[toolInfo(tool.name).category] ?? WrenchIcon;
  const t = useUiStrings().chat;
  const vm = toolViewModel(tool);
  const raw = summaryFor(vm, t);
  // A title that already is the summary (a shell call titled by its command) prints once.
  const summary = raw.trim() === tool.title.trim() ? '' : raw;
  const isError = tool.status === 'error';
  const hasDetail = vm.kind !== 'generic' || !!vm.inputPretty || !!vm.outputPretty || !!summary;

  return (
    <Collapsible
      data-slot="tool-call"
      data-tool-status={tool.status}
      className={cn('rounded-md border', isError ? 'border-destructive/30 bg-destructive/5' : 'border-border bg-card')}
    >
      <CollapsibleTrigger
        disabled={!hasDetail}
        className="group flex w-full items-center gap-2 px-2.5 py-2 text-left disabled:cursor-default"
      >
        <Glyph className={cn('size-3.5 shrink-0', isError ? 'text-destructive' : 'text-muted-foreground')} />
        {/* Title and summary shrink and truncate; the status and caret never leave the card. */}
        <span className="text-foreground min-w-0 truncate text-xs font-medium">{tool.title}</span>
        {summary && <span className="text-muted-foreground min-w-0 flex-1 truncate font-mono text-xs">{summary}</span>}
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          <StatusGlyph status={tool.status} />
          {hasDetail && (
            <CaretRightIcon className="text-muted-foreground size-3.5 transition-transform group-data-[state=open]:rotate-90 motion-reduce:transition-none" />
          )}
        </span>
      </CollapsibleTrigger>
      {hasDetail && (
        <CollapsibleContent>
          <div className="border-border border-t px-2.5 py-2">
            <ToolBody vm={vm} />
          </div>
        </CollapsibleContent>
      )}
    </Collapsible>
  );
}
