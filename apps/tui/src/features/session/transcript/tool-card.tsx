/**
 * One tool call, rendered per its `ToolViewModel` family.
 *
 * The shape comes from the SDK (`toolViewModel`, core/turns/view-model.ts) —
 * this file owns only the terminal presentation. The `switch` is exhaustive
 * over `ToolViewModel['kind']`; a new family added to the SDK fails the build
 * here instead of silently rendering nothing.
 *
 * Every card is: one status line (glyph + title), then at most a handful of
 * detail lines. A terminal row is expensive, so every body is bounded.
 */

import { type ToolView, type ToolViewModel, toolViewModel } from '@kortix/sdk';

import { clip, headLines, tailLines, toUnifiedDiff } from '../../../lib/turn-layout.ts';
import { theme } from '../../../theme.ts';
import { Spinner } from '../../../ui/index.ts';
import { transcriptSyntaxStyle } from './parts/text-part.tsx';

/** Shell stdout lines shown on a card. The command's tail is the part that
 *  says what happened; the head is usually a banner. */
export const SHELL_TAIL_LINES = 8;
/** Preview lines for a file read/write and for a generic tool's I/O. */
export const PREVIEW_LINES = 6;
/** Web-search results shown on a card. */
export const WEB_RESULT_LINES = 5;

function statusColor(status: ToolView['status']): string {
  if (status === 'error') return theme.danger;
  if (status === 'done') return theme.ok;
  return theme.dim;
}

function statusGlyph(status: ToolView['status']): string {
  if (status === 'error') return '✗';
  if (status === 'done') return '✓';
  if (status === 'pending') return '○';
  return '·';
}

/** The card's first line: status glyph, then the tool's own title. */
function CardHeader({ tool, width }: { tool: ToolView; width: number }) {
  if (tool.status === 'running') {
    return <Spinner label={clip(tool.title, Math.max(width - 2, 4))} />;
  }
  return (
    <text fg={theme.dim}>
      <span fg={statusColor(tool.status)}>{statusGlyph(tool.status)}</span>
      {` ${clip(tool.title, Math.max(width - 2, 4))}`}
    </text>
  );
}

function Detail({ children, fg = theme.faint }: { children: string; fg?: string }) {
  return <text fg={fg}>{children}</text>;
}

function More({ hidden }: { hidden: number }) {
  if (hidden <= 0) return null;
  return <Detail>{`  … ${hidden} more line${hidden === 1 ? '' : 's'}`}</Detail>;
}

function ShellBody({
  model,
  width,
}: { model: Extract<ToolViewModel, { kind: 'shell' }>; width: number }) {
  const { lines, hidden } = tailLines(model.stdout ?? '', SHELL_TAIL_LINES);
  const body = Math.max(width - 2, 10);
  return (
    <box flexDirection="column">
      <text fg={theme.dim}>
        <span fg={theme.accent}>{'  $ '}</span>
        {clip(model.command, body - 4)}
      </text>
      <More hidden={hidden} />
      {lines.map((line, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: output lines have no id
        <Detail key={`out-${index}`}>{`  ${clip(line, body - 2)}`}</Detail>
      ))}
      {model.exitCode === undefined ? null : (
        <text fg={model.exitCode === 0 ? theme.faint : theme.danger}>
          {`  exit ${model.exitCode}`}
        </text>
      )}
    </box>
  );
}

function FileBody({ path, preview, width }: { path: string; preview?: string; width: number }) {
  const { lines, hidden } = headLines(preview ?? '', PREVIEW_LINES);
  const body = Math.max(width - 2, 10);
  return (
    <box flexDirection="column">
      <Detail fg={theme.dim}>{`  ${clip(path, body)}`}</Detail>
      {lines.map((line, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: preview lines have no id
        <Detail key={`prev-${index}`}>{`  ${clip(line, body - 2)}`}</Detail>
      ))}
      <More hidden={hidden} />
    </box>
  );
}

function EditBody({
  model,
  width,
}: { model: Extract<ToolViewModel, { kind: 'file-edit' }>; width: number }) {
  const body = Math.max(width - 2, 10);
  return (
    <box flexDirection="column">
      <Detail fg={theme.dim}>{`  ${clip(model.path, body)}`}</Detail>
      {model.diff && model.diff.length > 0 ? (
        <diff
          diff={toUnifiedDiff(model.path, model.diff)}
          view="unified"
          syntaxStyle={transcriptSyntaxStyle()}
          width={body}
          height={Math.min(model.diff.length + 3, 14)}
        />
      ) : null}
    </box>
  );
}

function SearchBody({
  model,
  width,
}: { model: Extract<ToolViewModel, { kind: 'search' }>; width: number }) {
  const count = model.matches?.length ?? 0;
  const body = Math.max(width - 2, 10);
  return (
    <box flexDirection="column">
      <Detail fg={theme.dim}>{`  ${clip(model.pattern, body)}`}</Detail>
      <Detail>{`  ${count} match${count === 1 ? '' : 'es'}`}</Detail>
    </box>
  );
}

function TodoBody({
  model,
  width,
}: { model: Extract<ToolViewModel, { kind: 'todo' }>; width: number }) {
  const body = Math.max(width - 6, 8);
  return (
    <box flexDirection="column">
      {model.items.map((item, index) => (
        <Detail
          // biome-ignore lint/suspicious/noArrayIndexKey: todo items carry no id
          key={`todo-${index}`}
          fg={item.status === 'completed' ? theme.faint : theme.dim}
        >
          {`  [${item.status === 'completed' ? 'x' : ' '}] ${clip(item.content, body)}`}
        </Detail>
      ))}
    </box>
  );
}

function QuestionBody({
  model,
  width,
}: { model: Extract<ToolViewModel, { kind: 'question' }>; width: number }) {
  const body = Math.max(width - 4, 8);
  return (
    <box flexDirection="column">
      {model.questions.map((question, qIndex) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: questions carry no id
        <box key={`q-${qIndex}`} flexDirection="column">
          <Detail fg={theme.dim}>{`  ${clip(question.header || question.question, body)}`}</Detail>
          {question.options.map((option, oIndex) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: options carry no id
            <Detail key={`o-${oIndex}`}>{`    · ${clip(option.label, body - 2)}`}</Detail>
          ))}
        </box>
      ))}
    </box>
  );
}

function WebSearchBody({
  model,
  width,
}: { model: Extract<ToolViewModel, { kind: 'web-search' }>; width: number }) {
  const body = Math.max(width - 4, 8);
  const results = (model.results ?? []).slice(0, WEB_RESULT_LINES);
  return (
    <box flexDirection="column">
      <Detail fg={theme.dim}>{`  “${clip(model.query, body)}”`}</Detail>
      {model.error ? <Detail fg={theme.danger}>{`  ${clip(model.error, body)}`}</Detail> : null}
      {results.map((result) => (
        <Detail
          key={result.url || result.title}
        >{`  · ${clip(result.title || result.url, body)}`}</Detail>
      ))}
    </box>
  );
}

function GenericBody({
  model,
  width,
}: { model: Extract<ToolViewModel, { kind: 'generic' }>; width: number }) {
  const body = Math.max(width - 2, 10);
  const input = headLines(model.inputPretty ?? '', PREVIEW_LINES);
  const output = headLines(model.outputPretty ?? '', PREVIEW_LINES);
  return (
    <box flexDirection="column">
      {input.lines.map((line, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: JSON lines have no id
        <Detail key={`in-${index}`}>{`  ${clip(line, body - 2)}`}</Detail>
      ))}
      <More hidden={input.hidden} />
      {output.lines.map((line, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: JSON lines have no id
        <Detail key={`gout-${index}`}>{`  ${clip(line, body - 2)}`}</Detail>
      ))}
      <More hidden={output.hidden} />
    </box>
  );
}

function ToolBody({ model, width }: { model: ToolViewModel; width: number }) {
  switch (model.kind) {
    case 'shell':
      return <ShellBody model={model} width={width} />;
    case 'file-read':
    case 'file-write':
      return <FileBody path={model.path} preview={model.preview} width={width} />;
    case 'file-edit':
      return <EditBody model={model} width={width} />;
    case 'search':
      return <SearchBody model={model} width={width} />;
    case 'task':
      return (
        <box flexDirection="column">
          <Detail fg={theme.dim}>{`  ${clip(model.description, Math.max(width - 2, 8))}`}</Detail>
          {model.agent ? <Detail>{`  agent ${model.agent}`}</Detail> : null}
        </box>
      );
    case 'todo':
      return <TodoBody model={model} width={width} />;
    case 'question':
      return <QuestionBody model={model} width={width} />;
    case 'web-search':
      return <WebSearchBody model={model} width={width} />;
    case 'generic':
      return <GenericBody model={model} width={width} />;
    default: {
      const _exhaustive: never = model;
      return _exhaustive;
    }
  }
}

export interface ToolCardProps {
  tool: ToolView;
  width: number;
}

export function ToolCard({ tool, width }: ToolCardProps) {
  const model = toolViewModel(tool);
  return (
    <box flexDirection="column">
      <CardHeader tool={tool} width={width} />
      <ToolBody model={model} width={width} />
      {tool.status === 'error' && tool.error ? (
        <text fg={theme.danger}>{`  ${clip(tool.error, Math.max(width - 2, 8))}`}</text>
      ) : null}
    </box>
  );
}
