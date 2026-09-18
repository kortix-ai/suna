/**
 * The tool set a pi session runs with, bound to the sandbox's OWN filesystem
 * and shell. pi's built-in bash/read/write/edit take an `ExecutionEnv`; the
 * single-sandbox architecture hands them `NodeExecutionEnv` on `/workspace`,
 * so every tool call is a local syscall — no RPC, no second box.
 *
 * glob/grep are Kortix additions on top of ripgrep (pi ships none), named
 * exactly as OpenCode's so `toolViewModel()` in the web client needs no
 * remapping. `question` is the interactive ask the product renders.
 */
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  GREP_MAX_LINE_LENGTH,
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
  executeShellWithCapture,
  formatSize,
  getOrThrow,
  truncateLine,
  type AgentHarnessTool,
  type AgentHarnessToolInvocation,
  type AgentTool,
  type ExecutionEnv,
  type ExecutionToolContext,
  type ShellCaptureResult,
} from '@earendil-works/pi-agent-core'
import { BACKGROUND_CONTEXT, withAbortSignal } from '@earendil-works/pi-agent-core/harness/context'
import { Type } from 'typebox'
import type { QuestionBroker, QuestionInfo } from './interactions'

const globSchema = Type.Object({
  pattern: Type.String({ minLength: 1, description: 'Glob pattern to match, such as **/*.ts or src/**/test-*.tsx' }),
  path: Type.Optional(Type.String({ description: 'Directory to search, relative to the workspace or absolute' })),
})

const grepSchema = Type.Object({
  pattern: Type.String({ minLength: 1, description: 'Regular expression to search for' }),
  path: Type.Optional(Type.String({ description: 'File or directory to search, relative to the workspace or absolute' })),
  include: Type.Optional(Type.String({ description: 'Optional glob that limits searched files, such as *.ts' })),
})

const questionSchema = Type.Object({
  questions: Type.Array(
    Type.Object({
      question: Type.String({ description: 'The complete question to ask' }),
      header: Type.String({ description: 'Very short label (max 30 chars)' }),
      options: Type.Array(
        Type.Object({
          label: Type.String({ description: 'Choice label (1-5 words)' }),
          description: Type.String({ description: 'What choosing this means' }),
        }),
        { minItems: 1 },
      ),
      multiple: Type.Optional(Type.Boolean({ description: 'Allow selecting several options' })),
      custom: Type.Optional(Type.Boolean({ description: 'Allow a free-text answer' })),
    }),
    { minItems: 1 },
  ),
})

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

function outputResult(result: ShellCaptureResult, emptyMessage: string, options: { truncateMatchLines?: boolean; stripDotSlash?: boolean } = {}) {
  let raw = result.output.replaceAll('\r\n', '\n').trimEnd()
  if (options.stripDotSlash) raw = raw.replace(/^\.\//gm, '')
  if (!raw) return { content: [{ type: 'text' as const, text: emptyMessage }], details: undefined }
  let truncatedLines = 0
  let text = options.truncateMatchLines
    ? raw
        .split('\n')
        .map((line) => {
          const truncated = truncateLine(line, GREP_MAX_LINE_LENGTH)
          if (truncated.wasTruncated) truncatedLines += 1
          return truncated.text
        })
        .join('\n')
    : raw
  if (result.truncated) {
    text += `\n\n[Showing first ${result.truncation.outputLines} of ${result.truncation.totalLines} lines (${formatSize(DEFAULT_MAX_BYTES)} or ${DEFAULT_MAX_LINES} line limit).]`
  }
  if (truncatedLines > 0) {
    text += `\n\n[Truncated ${truncatedLines} matching line${truncatedLines === 1 ? '' : 's'} to ${GREP_MAX_LINE_LENGTH} characters.]`
  }
  return { content: [{ type: 'text' as const, text }], details: undefined }
}

function commandError(tool: string, result: ShellCaptureResult): Error {
  const detail = result.output.trim()
  return new Error(`${tool} failed with exit code ${result.exitCode ?? 'unknown'}${detail ? `: ${detail}` : ''}`)
}

const SEARCH_LIMITS = { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES, retain: 'head' as const }

type Harness = AgentHarnessTool<ExecutionToolContext, any, any>

export function createGlobTool(): Harness {
  return {
    name: 'glob',
    label: 'glob',
    description: `Find workspace files by glob pattern. Results are sorted by path and truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB.`,
    parameters: globSchema,
    async execute(_id, { pattern, path }, _onUpdate, { env }, _invocation, context) {
      const command = ['rg', '--files', '--hidden', '--sort', 'path', '--glob', shellQuote('!.git/**'), '--glob', shellQuote(pattern), '--', ...(path?.trim() ? [shellQuote(path.trim())] : [])].join(' ')
      const result = getOrThrow(await executeShellWithCapture(env, command, { cwd: env.cwd, limits: SEARCH_LIMITS } as never, context))
      if (result.exitCode !== 0 && result.exitCode !== 1) throw commandError('glob', result)
      return outputResult(result, 'No files found')
    },
  }
}

export function createGrepTool(): Harness {
  return {
    name: 'grep',
    label: 'grep',
    description: `Search workspace file contents with a regular expression. Results use path:line:text format and are truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB.`,
    parameters: grepSchema,
    async execute(_id, { pattern, path, include }, _onUpdate, { env }, _invocation, context) {
      const searched = path?.trim() ? [shellQuote(path.trim())] : []
      const command = [
        'rg', '--line-number', '--with-filename', '--no-heading', '--color', 'never', '--hidden', '--sort', 'path',
        '--glob', shellQuote('!.git/**'),
        ...(include?.trim() ? ['--glob', shellQuote(include.trim())] : []),
        '--', shellQuote(pattern), ...(searched.length > 0 ? searched : [shellQuote('.')]),
      ].join(' ')
      const result = getOrThrow(await executeShellWithCapture(env, command, { cwd: env.cwd, limits: SEARCH_LIMITS } as never, context))
      if (result.exitCode === 1) return { content: [{ type: 'text' as const, text: 'No matches found' }], details: undefined }
      if (result.exitCode !== 0) throw commandError('grep', result)
      return outputResult(result, 'No matches found', { truncateMatchLines: true, stripDotSlash: searched.length === 0 })
    },
  }
}

/** Ask the user; the turn blocks until the product answers over the wire. */
export function createQuestionTool(
  questions: QuestionBroker,
  ref: (toolCallId: string) => { messageID: string; callID: string } | undefined,
): AgentTool<typeof questionSchema, undefined> {
  return {
    name: 'question',
    label: 'question',
    description:
      'Ask the user one or more questions and wait for the answers. Use it when a decision needs the user, not to narrate progress. Each question has a short header, the full question, and 2-5 options.',
    parameters: questionSchema,
    async execute(toolCallId, params) {
      const asked = params.questions as QuestionInfo[]
      const answers = await questions.ask(asked, ref(toolCallId))
      if (answers === null) throw new Error('The user dismissed the question.')
      const text = asked.map((q, i) => `${q.header}: ${(answers[i] ?? []).join(', ') || '(no answer)'}`).join('\n')
      return { content: [{ type: 'text', text: `User answered:\n${text}` }], details: undefined }
    },
  }
}

/** A harness tool needs a per-call invocation identity; pi's own harness mints it, here a stub. */
function invocationFor(toolCallId: string): AgentHarnessToolInvocation {
  return {
    invocationId: toolCallId,
    operationId: toolCallId,
    turnId: toolCallId,
    getMemo: async () => undefined,
    setMemo: async () => {},
  }
}

/** Bind a harness tool to this sandbox's execution env for pi's `Agent`. */
export function bindTool(tool: Harness, env: ExecutionEnv): AgentTool<any, any> {
  return {
    ...tool,
    execute: (toolCallId, params, signal, onUpdate) =>
      tool.execute(
        toolCallId,
        params,
        (partial) => onUpdate?.(partial),
        { env },
        invocationFor(toolCallId),
        signal ? withAbortSignal(signal, BACKGROUND_CONTEXT) : BACKGROUND_CONTEXT,
      ),
  }
}

export function createWorkspaceTools(env: ExecutionEnv): AgentTool<any, any>[] {
  return [createBashTool(), createReadTool(), createWriteTool(), createEditTool(), createGlobTool(), createGrepTool()].map(
    (tool) => bindTool(tool as Harness, env),
  )
}
