/**
 * The tool set a pi session runs with, bound to the sandbox's OWN filesystem
 * and shell. pi's built-in bash/read/write/edit run on `/workspace` in this
 * process, so every tool call is a local syscall — no RPC, no second box.
 *
 * glob/grep are Kortix additions on top of ripgrep, named exactly as
 * OpenCode's so `toolViewModel()` in the web client needs no remapping
 * (pi's own `find`/`grep` take other arguments). `question` is the interactive
 * ask the product renders. The hosted tools (the Kortix tools the project
 * loads and the project's own, services/tools) run here exactly as every
 * other harness runs them.
 */
import type { AgentTool } from '@earendil-works/pi-agent-core'
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  createBashToolDefinition,
  createEditToolDefinition,
  createLocalBashOperations,
  createReadToolDefinition,
  createWriteToolDefinition,
  formatSize,
  truncateHead,
  truncateLine,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import type { RuntimeQuestion } from '@kortix/api-contract/transcript'
import { runTool, sessionEnv, type HostedTool } from '@/services/tools/host'
import { AGENT_SHELL_ENV } from '../shared/agent-env-file'
import type { QuestionBroker } from './interactions'

/** pi's own grep cap for one matching line. */
const GREP_MAX_LINE_LENGTH = 500

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

interface SearchResult {
  output: string
  exitCode: number | null
  /** rg was stopped at `SEARCH_CAPTURE_BYTES`; more results exist. */
  capped?: boolean
}

/** Bytes of rg output kept in memory. Past it rg is killed: the tool shows only the first `DEFAULT_MAX_BYTES` anyway. */
const SEARCH_CAPTURE_BYTES = DEFAULT_MAX_BYTES * 2

/**
 * pi spreads the live process.env into every shell itself; BASH_ENV adds the
 * egress shim's proxy + CA, which only the agent env file carries.
 */
const shell = createLocalBashOperations()
const shellEnv = (env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv => ({ ...env, ...AGENT_SHELL_ENV })

async function runSearch(command: string, cwd: string, signal: AbortSignal | undefined): Promise<SearchResult> {
  const chunks: Buffer[] = []
  let bytes = 0
  const cap = new AbortController()
  const onData = (data: Buffer) => {
    if (cap.signal.aborted) return
    chunks.push(data)
    bytes += data.length
    if (bytes > SEARCH_CAPTURE_BYTES) cap.abort()
  }
  try {
    const { exitCode } = await shell.exec(command, cwd, { onData, signal: signal ? AbortSignal.any([signal, cap.signal]) : cap.signal, env: shellEnv() })
    return { output: Buffer.concat(chunks).toString('utf8'), exitCode }
  } catch (err) {
    if (!cap.signal.aborted || signal?.aborted) throw err
    return { output: Buffer.concat(chunks).toString('utf8'), exitCode: 0, capped: true }
  }
}

function outputResult(result: SearchResult, emptyMessage: string, options: { truncateMatchLines?: boolean; stripDotSlash?: boolean } = {}) {
  let raw = result.output.replaceAll('\r\n', '\n').trimEnd()
  if (options.stripDotSlash) raw = raw.replace(/^\.\//gm, '')
  if (!raw) return { content: [{ type: 'text' as const, text: emptyMessage }], details: undefined }
  const head = truncateHead(raw, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES })
  let truncatedLines = 0
  let text = options.truncateMatchLines
    ? head.content
        .split('\n')
        .map((line) => {
          const truncated = truncateLine(line, GREP_MAX_LINE_LENGTH)
          if (truncated.wasTruncated) truncatedLines += 1
          return truncated.text
        })
        .join('\n')
    : head.content
  if (result.capped) {
    text += `\n\n[Showing first ${head.outputLines} lines; more results exist (${formatSize(DEFAULT_MAX_BYTES)} or ${DEFAULT_MAX_LINES} line limit). Narrow the pattern or path.]`
  } else if (head.truncated) {
    text += `\n\n[Showing first ${head.outputLines} of ${head.totalLines} lines (${formatSize(DEFAULT_MAX_BYTES)} or ${DEFAULT_MAX_LINES} line limit).]`
  }
  if (truncatedLines > 0) {
    text += `\n\n[Truncated ${truncatedLines} matching line${truncatedLines === 1 ? '' : 's'} to ${GREP_MAX_LINE_LENGTH} characters.]`
  }
  return { content: [{ type: 'text' as const, text }], details: undefined }
}

function commandError(tool: string, result: SearchResult): Error {
  const detail = result.output.trim()
  return new Error(`${tool} failed with exit code ${result.exitCode ?? 'unknown'}${detail ? `: ${detail}` : ''}`)
}

export function createGlobTool(cwd: string): AgentTool<typeof globSchema> {
  return {
    name: 'glob',
    label: 'glob',
    description: `Find workspace files by glob pattern. Results are sorted by path and truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB.`,
    parameters: globSchema,
    async execute(_id, { pattern, path }, signal) {
      const command = ['rg', '--files', '--hidden', '--sort', 'path', '--glob', shellQuote('!.git/**'), '--glob', shellQuote(pattern), '--', ...(path?.trim() ? [shellQuote(path.trim())] : [])].join(' ')
      const result = await runSearch(command, cwd, signal)
      if (result.exitCode !== 0 && result.exitCode !== 1) throw commandError('glob', result)
      return outputResult(result, 'No files found')
    },
  }
}

export function createGrepTool(cwd: string): AgentTool<typeof grepSchema> {
  return {
    name: 'grep',
    label: 'grep',
    description: `Search workspace file contents with a regular expression. Results use path:line:text format and are truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB.`,
    parameters: grepSchema,
    async execute(_id, { pattern, path, include }, signal) {
      const searched = path?.trim() ? [shellQuote(path.trim())] : []
      const command = [
        'rg', '--line-number', '--with-filename', '--no-heading', '--color', 'never', '--hidden', '--sort', 'path',
        '--glob', shellQuote('!.git/**'),
        ...(include?.trim() ? ['--glob', shellQuote(include.trim())] : []),
        '--', shellQuote(pattern), ...(searched.length > 0 ? searched : [shellQuote('.')]),
      ].join(' ')
      const result = await runSearch(command, cwd, signal)
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
): AgentTool<typeof questionSchema, { answers: string[][] }> {
  return {
    name: 'question',
    label: 'question',
    description:
      'Ask the user one or more questions and wait for the answers. Use it when a decision needs the user, not to narrate progress. Each question has a short header, the full question, and 2-5 options.',
    parameters: questionSchema,
    async execute(toolCallId, params) {
      const asked = params.questions as RuntimeQuestion[]
      const answers = await questions.ask(asked, ref(toolCallId))
      if (answers === null) throw new Error('The user dismissed the question.')
      const text = asked.map((q, i) => `${q.header}: ${(answers[i] ?? []).join(', ') || '(no answer)'}`).join('\n')
      // `details` becomes the part's `state.metadata`: the answers a client shows.
      return { content: [{ type: 'text', text: `User answered:\n${text}` }], details: { answers } }
    },
  }
}

/** A pi tool definition as the `Agent` runs it. The built-ins read nothing from an extension context. */
function agentTool(definition: ToolDefinition<any, any, any>): AgentTool<any, any> {
  return {
    name: definition.name,
    label: definition.label,
    description: definition.description,
    parameters: definition.parameters,
    prepareArguments: definition.prepareArguments,
    execute: (toolCallId, params, signal, onUpdate) => definition.execute(toolCallId, params, signal, onUpdate, undefined as never),
  }
}

/** A hosted tool as the pi `Agent` runs it: the call's context names this session and agent. */
function hostedAgentTool(tool: HostedTool, cwd: string, caller: () => { sessionId: string; agent: string }): AgentTool<any, undefined> {
  return {
    name: tool.name,
    label: tool.name,
    description: tool.description,
    parameters: tool.parameters as never,
    async execute(_id, args, signal) {
      const text = await runTool(tool, args as Record<string, unknown>, { ...caller(), directory: cwd, env: sessionEnv(), signal: signal ?? new AbortController().signal })
      return { content: [{ type: 'text', text }], details: undefined }
    },
  }
}

/** Every tool a root agent and a subagent can be given: pi's workspace tools on this sandbox, then the hosted tools. */
export function createWorkspaceTools(
  cwd: string,
  hosted: readonly HostedTool[] = [],
  caller: () => { sessionId: string; agent: string } = () => ({ sessionId: '', agent: '' }),
): AgentTool<any, any>[] {
  return [
    // PI_* session variables need an extension context; the agent env file carries the session's own.
    agentTool(createBashToolDefinition(cwd, { exposeSessionEnvironment: false, spawnHook: (spawn) => ({ ...spawn, env: shellEnv(spawn.env) }) })),
    agentTool(createReadToolDefinition(cwd)),
    agentTool(createWriteToolDefinition(cwd)),
    agentTool(createEditToolDefinition(cwd)),
    createGlobTool(cwd),
    createGrepTool(cwd),
    ...hosted.map((tool) => hostedAgentTool(tool, cwd, caller)),
  ]
}
