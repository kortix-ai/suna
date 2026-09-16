import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  GREP_MAX_LINE_LENGTH,
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
  formatSize,
  getOrThrow,
  truncateHead,
  truncateLine,
  type AgentHarnessTool,
  type AgentTool,
  type ExecutionEnv,
  type ExecutionToolContext,
  type TruncationResult,
} from '@earendil-works/pi-agent-core';
import { Type } from 'typebox';

const globSchema = Type.Object({
  pattern: Type.String({
    minLength: 1,
    description: 'Glob pattern to match, such as **/*.ts or src/**/test-*.tsx',
  }),
  path: Type.Optional(
    Type.String({ description: 'Directory to search, relative to the workspace or absolute' }),
  ),
});

const grepSchema = Type.Object({
  pattern: Type.String({
    minLength: 1,
    description: 'Regular expression to search for',
  }),
  path: Type.Optional(
    Type.String({ description: 'File or directory to search, relative to the workspace or absolute' }),
  ),
  include: Type.Optional(
    Type.String({ description: 'Optional glob that limits searched files, such as *.ts' }),
  ),
});

export interface WorkspaceSearchToolDetails {
  truncation?: TruncationResult;
  truncatedLines?: number;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function pathArgument(path: string | undefined): string[] {
  const value = path?.trim();
  return value ? [shellQuote(value)] : [];
}

function outputResult(
  stdout: string,
  emptyMessage: string,
  options: { truncateMatchLines?: boolean } = {},
) {
  const raw = stdout.replaceAll('\r\n', '\n').trimEnd();
  if (!raw) {
    return {
      content: [{ type: 'text' as const, text: emptyMessage }],
      details: undefined,
    };
  }

  let truncatedLines = 0;
  const normalized = options.truncateMatchLines
    ? raw
        .split('\n')
        .map((line) => {
          const result = truncateLine(line, GREP_MAX_LINE_LENGTH);
          if (result.wasTruncated) truncatedLines += 1;
          return result.text;
        })
        .join('\n')
    : raw;
  const truncation = truncateHead(normalized);
  let text = truncation.content;
  if (truncation.truncated) {
    text += `\n\n[Showing first ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(DEFAULT_MAX_BYTES)} or ${DEFAULT_MAX_LINES} line limit).]`;
  }
  if (truncatedLines > 0) {
    text += `\n\n[Truncated ${truncatedLines} matching line${truncatedLines === 1 ? '' : 's'} to ${GREP_MAX_LINE_LENGTH} characters.]`;
  }
  const details: WorkspaceSearchToolDetails | undefined =
    truncation.truncated || truncatedLines > 0
      ? {
          truncation: truncation.truncated ? truncation : undefined,
          truncatedLines: truncatedLines || undefined,
        }
      : undefined;
  return { content: [{ type: 'text' as const, text }], details };
}

function commandError(tool: string, exitCode: number, stderr: string): Error {
  const detail = stderr.trim();
  return new Error(
    `${tool} failed with exit code ${exitCode}${detail ? `: ${detail}` : ''}`,
  );
}

export function createGlobTool(): AgentHarnessTool<
  ExecutionToolContext,
  typeof globSchema,
  WorkspaceSearchToolDetails | undefined
> {
  return {
    name: 'glob',
    label: 'glob',
    description: `Find workspace files by glob pattern. Results are sorted by path and truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB.`,
    parameters: globSchema,
    async execute(_toolCallId, { pattern, path }, signal, _onUpdate, { env }) {
      const command = [
        'rg',
        '--files',
        '--hidden',
        '--sort',
        'path',
        '--glob',
        shellQuote('!.git/**'),
        '--glob',
        shellQuote(pattern),
        '--',
        ...pathArgument(path),
      ].join(' ');
      const result = getOrThrow(
        await env.exec(command, { cwd: env.cwd, abortSignal: signal }),
      );
      if (result.exitCode !== 0 && result.exitCode !== 1) {
        throw commandError('glob', result.exitCode, result.stderr);
      }
      return outputResult(result.stdout, 'No files found');
    },
  };
}

export function createGrepTool(): AgentHarnessTool<
  ExecutionToolContext,
  typeof grepSchema,
  WorkspaceSearchToolDetails | undefined
> {
  return {
    name: 'grep',
    label: 'grep',
    description: `Search workspace file contents with a regular expression. Results use path:line:text format and are truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB.`,
    parameters: grepSchema,
    async execute(_toolCallId, { pattern, path, include }, signal, _onUpdate, { env }) {
      const searchedPath = pathArgument(path);
      const command = [
        'rg',
        '--line-number',
        '--with-filename',
        '--no-heading',
        '--color',
        'never',
        '--hidden',
        '--sort',
        'path',
        '--glob',
        shellQuote('!.git/**'),
        ...(include?.trim() ? ['--glob', shellQuote(include.trim())] : []),
        '--',
        shellQuote(pattern),
        ...(searchedPath.length > 0 ? searchedPath : [shellQuote('.')]),
      ].join(' ');
      const result = getOrThrow(
        await env.exec(command, { cwd: env.cwd, abortSignal: signal }),
      );
      if (result.exitCode === 1) return outputResult('', 'No matches found');
      if (result.exitCode !== 0) throw commandError('grep', result.exitCode, result.stderr);
      const stdout = searchedPath.length === 0
        ? result.stdout.replace(/^\.\//gm, '')
        : result.stdout;
      return outputResult(stdout, 'No matches found', { truncateMatchLines: true });
    },
  };
}

function bindTool(tool: AgentHarnessTool<ExecutionToolContext>, context: ExecutionToolContext) {
  return {
    ...tool,
    execute: (toolCallId: string, params: unknown, signal?: AbortSignal, onUpdate?: unknown) =>
      tool.execute(toolCallId, params as never, signal, onUpdate as never, context),
  } as AgentTool;
}

export function createWorkspaceTools(env: ExecutionEnv): AgentTool[] {
  const context = { env };
  return [
    createBashTool(),
    createReadTool(),
    createWriteTool(),
    createEditTool(),
    createGlobTool(),
    createGrepTool(),
  ].map((tool) => bindTool(tool, context));
}
