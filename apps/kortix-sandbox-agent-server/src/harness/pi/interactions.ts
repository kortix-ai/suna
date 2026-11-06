/**
 * The two interactions a turn can raise for a person: a permission request
 * before a tool runs, and a question the agent asks. Both are Kortix types
 * (`RuntimePermissionRequest`, `RuntimeQuestionRequest`), answered over the
 * routes the product already calls (`/permission/:id/reply`,
 * `/question/:id/reply|reject`).
 *
 * Neither holds the session. Each waits for a live answer for a short window
 * (`AskRelayAnswer.liveWaitMs`), then PARKS: the tool call returns, the turn
 * goes on, and the ask stays open in apps/api (Review, "Needs you") until a
 * person answers it. A new message parks every open ask at once.
 */
import { createHash, randomUUID } from 'node:crypto'
import type {
  RuntimePermissionCapability,
  RuntimePermissionReply,
  RuntimePermissionRequest,
  RuntimeQuestion,
  RuntimeQuestionRequest,
  RuntimeToolRef,
} from '@kortix/api-contract/transcript'
import { homedir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { comparePatterns } from '@kortix/api-contract/permission-rules'
import { KORTIX_EDIT_TOOLS } from '@/services/tools/tool'
import type { RuntimeFrame } from './transcript'

export type PermissionReply = RuntimePermissionReply

/** `allow` | `ask` | `deny` per tool name, `*` as the default. */
export type PermissionRule = 'allow' | 'ask' | 'deny'
/** One tool's rule in the compiled `permission` block: a bare action, or a glob-pattern -> action map. */
export type PermissionRuleConfig = PermissionRule | Record<string, PermissionRule>
export type PermissionPolicy = Record<string, PermissionRuleConfig>

const RULES = new Set(['allow', 'ask', 'deny'])
const isRule = (value: unknown): value is PermissionRule => typeof value === 'string' && RULES.has(value)

/**
 * Compile the manifest's compiled `permission` block
 * (`{ [tool]: 'allow'|'ask'|'deny' | { [pattern]: rule } }`).
 * Pattern maps are KEPT whole and matched per call by {@link resolveRule} —
 * collapsing them to their `*` entry would turn an explicit
 * `bash: { 'rm -rf *': 'deny', '*': 'allow' }` into an unconditional allow.
 * A tool with no rule is `allow`. A bare action (`permission: deny`) is the
 * whole-agent form: it covers every tool.
 */
export function compilePermissionPolicy(raw: unknown): PermissionPolicy {
  const policy: PermissionPolicy = {}
  if (isRule(raw)) return { '*': raw }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return policy
  for (const [tool, value] of Object.entries(raw as Record<string, unknown>)) {
    if (isRule(value)) policy[tool] = value
    else if (value && typeof value === 'object' && !Array.isArray(value)) {
      const patterns: Record<string, PermissionRule> = {}
      for (const [pattern, rule] of Object.entries(value as Record<string, unknown>)) {
        if (isRule(rule)) patterns[pattern] = rule
      }
      if (Object.keys(patterns).length > 0) policy[tool] = patterns
    }
  }
  return policy
}

/**
 * The permission pattern match:
 * backslashes normalise to `/`, `*` becomes `.*`, `?` becomes `.`, every other
 * regex metacharacter is escaped, and the whole pattern is anchored and
 * dot-all. A pattern ending in ` *` also matches the bare command, so `ls *`
 * covers a plain `ls`.
 */
export function wildcardMatch(value: string, pattern: string): boolean {
  let escaped = pattern
    .replaceAll('\\', '/')
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.')
  if (escaped.endsWith(' .*')) escaped = `${escaped.slice(0, -3)}( .*)?`
  return new RegExp(`^${escaped}$`, 's').test(value.replaceAll('\\', '/'))
}

/**
 * The Kortix precedence (`@kortix/api-contract/permission-rules`): the most
 * specific matching pattern wins, whatever the authored order, so the
 * one-character `*` is the weakest entry in the map.
 */
function matchPatterns(subject: string, patterns: Record<string, PermissionRule>): PermissionRule | undefined {
  let matched: PermissionRule | undefined
  const sorted = Object.entries(patterns).sort(([a], [b]) => comparePatterns(a, b))
  for (const [pattern, rule] of sorted) {
    if (wildcardMatch(subject, pattern)) matched = rule
  }
  return matched
}

/** `<<word`, `<<-word`, `<<'word'`, `<<"word"`, `<<\\word`; never `<<<`. */
const HEREDOC = /^<<(-?)[ \t]*(?:'([^'\n]+)'|"([^"\n]+)"|(\\?)([A-Za-z0-9_.-]+))/

interface Heredoc {
  delimiter: string
  /** `<<-`: the delimiter line may start with tabs. */
  tabs: boolean
  /** A quoted delimiter: bash expands nothing in the body. */
  quoted: boolean
}

/**
 * Where the bodies of `heredocs` end, starting at `from` (the line after the
 * command): the index of the last delimiter line's newline, or the end. -1
 * when a delimiter is missing (`$((1<<2))` is not a heredoc) or an unquoted
 * body runs a substitution: the body is then read as commands.
 */
function heredocBodiesEnd(line: string, from: number, heredocs: Heredoc[]): number {
  let at = from
  for (const heredoc of heredocs) {
    const bodyStart = at
    for (;;) {
      if (at > line.length) return -1
      const newline = line.indexOf('\n', at)
      const end = newline < 0 ? line.length : newline
      const text = line.slice(at, end)
      if ((heredoc.tabs ? text.replace(/^\t+/, '') : text) === heredoc.delimiter) {
        if (!heredoc.quoted && /\$\(|`/.test(line.slice(bodyStart, at))) return -1
        at = end + 1
        break
      }
      at = end + 1
    }
  }
  return at - 1
}

/**
 * Commands that read stdin as data. Any other program can run its stdin
 * (`sh`, `$SHELL`, `./run.sh`, `sudo …`), so only these make a heredoc body
 * data. `sed`, `awk`, `psql` and `mysql` are left out: their stdin can run a
 * shell command.
 */
const STDIN_DATA_READERS = new Set([
  'cat', 'tee', 'grep', 'egrep', 'fgrep', 'rg', 'head', 'tail', 'wc', 'sort', 'uniq', 'tr', 'cut', 'jq', 'yq',
  'base64', 'gh', 'git', 'diff', 'cmp', 'comm', 'column', 'envsubst', 'read', 'mapfile', 'readarray', 'fmt', 'fold',
  'nl', 'paste', 'xxd', 'od', 'gzip', 'md5sum', 'sha256sum', 'curl',
])

/**
 * Whether a heredoc's line may run the body: some command on it (the one
 * that declares the heredoc, or one it is piped to) is not a data reader.
 * Leading `NAME=value` assignments are skipped. Word based, so a quoted `|`
 * reads as a new command: it errs towards reading a body as commands.
 */
function readsStdinAsCode(text: string): boolean {
  return text.split(/[;&|()]+/).some((segment) => {
    const words = segment.trim().replace(RESERVED_PREFIX, '').split(/\s+/).filter((word) => word && !/^\w+=/.test(word))
    return words.length > 0 && !STDIN_DATA_READERS.has(words[0]!)
  })
}

const RESERVED_PREFIX = /^(?:(?:if|then|elif|else|do|while|until|time|!|\{)\s+)+/
const RESERVED_ALONE = new Set(['fi', 'done', 'esac', '}'])

/**
 * The commands of a bash line, as the permission check asks about them:
 * the line splits on unquoted `;`, `&`, `|` and newlines (so `&&`, `||` and
 * `|&` too), and every `$(…)`, `` `…` ``, `<(…)`, `>(…)` and `( … )` body is
 * read as commands of its own. A command keeps its substitutions' text.
 * A `#` comment is skipped. A heredoc body is data and is skipped, except an
 * unquoted one that runs `$(…)` or `` `…` `` (bash expands those) and one
 * whose line has a command that is not a data reader (`sh <<EOF`,
 * `cat <<EOF | bash`): those bodies are read as commands. `null` when the quotes or brackets do not balance.
 * ponytail: not a bash grammar — `case` arms read as unbalanced or as extra
 * commands, so they fail closed. Use tree-sitter-bash when a manifest needs
 * them exact.
 */
export function bashCommands(line: string): string[] | null {
  const commands: string[] = []
  // Reads from `start` up to `close` ('' = the end) and returns the index after it, or -1.
  const read = (start: number, close: string): number => {
    let piece = ''
    let quote = ''
    let heredocs: Heredoc[] = []
    let lineStart = start
    // The index of the last backslash-escaped character: `a\ #b` is one word, not a comment.
    let escaped = -1
    const flush = () => {
      const command = piece.trim().replace(RESERVED_PREFIX, '')
      // A `( … )` group is not a command: its body was read on its own.
      if (command && !RESERVED_ALONE.has(command) && !command.startsWith('(')) commands.push(command)
      piece = ''
    }
    let i = start
    while (i < line.length) {
      const ch = line[i]!
      if (quote === "'") {
        piece += ch
        if (ch === "'") quote = ''
        i++
        continue
      }
      if (ch === '\\') {
        piece += line.slice(i, i + 2)
        i += 2
        escaped = i - 1
        continue
      }
      if (ch === '"' || (ch === "'" && !quote)) {
        quote = quote ? '' : ch
        piece += ch
        i++
        continue
      }
      if (!quote && close && ch === close) {
        flush()
        return i + 1
      }
      if (ch === '`' || (ch === '(' && (!quote || line[i - 1] === '$'))) {
        const end = read(i + 1, ch === '`' ? '`' : ')')
        if (end < 0) return -1
        piece += line.slice(i, end)
        i = end
        continue
      }
      if (!quote && ch === ')') return -1
      if (!quote && ch === '#' && (i === start || (/[\s;&|(]/.test(line[i - 1]!) && escaped !== i - 1))) {
        const end = line.indexOf('\n', i)
        i = end < 0 ? line.length : end
        continue
      }
      const heredoc = !quote && ch === '<' ? HEREDOC.exec(line.slice(i)) : null
      // Quote removal joins a delimiter word (`<<'E'OF` is `EOF`): a word read
      // only in part is no heredoc, and its lines stay commands.
      if (heredoc && line[i - 1] !== '<' && !/[^\s;&|()<>]/.test(line[i + heredoc[0].length] ?? '')) {
        heredocs.push({ delimiter: heredoc[2] ?? heredoc[3] ?? heredoc[5]!, tabs: heredoc[1] === '-', quoted: !heredoc[5] || !!heredoc[4] })
        piece += heredoc[0]
        i += heredoc[0].length
        continue
      }
      if (!quote && ch === '\n' && heredocs.length > 0) {
        const end = readsStdinAsCode(line.slice(lineStart, i)) ? -1 : heredocBodiesEnd(line, i + 1, heredocs)
        heredocs = []
        if (end >= 0) {
          flush()
          i = end
          continue
        }
      }
      if (ch === '\n') lineStart = i + 1
      // `2>&1`, `&>file` and `>|file` are redirections, not separators.
      const redirect = line[i - 1] === '>' || line[i - 1] === '<' || (ch === '&' && line[i + 1] === '>')
      if (!quote && (ch === ';' || ch === '\n' || ((ch === '&' || ch === '|') && !redirect))) {
        flush()
        i++
        continue
      }
      piece += ch
      i++
    }
    if (quote || close) return -1
    flush()
    return i
  }
  return read(0, '') < 0 ? null : commands
}

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g

/**
 * The file a `path` argument names, resolved as pi's file tools resolve it
 * (pi-coding-agent `utils/paths.ts` `resolvePath`, not exported): unicode
 * spaces, a leading `@`, `~`, `file://`, then `.` and `..` against the
 * workspace. Trimmed, as the glob and grep tools trim. `undefined` when the
 * path does not parse.
 */
export function toolPath(raw: string, workspace: string): string | undefined {
  let path = raw.trim().replace(UNICODE_SPACES, ' ')
  if (path.startsWith('@')) path = path.slice(1)
  if (path === '~' || path.startsWith('~/')) path = join(homedir(), path.slice(2))
  if (path.startsWith('file://')) {
    try {
      path = fileURLToPath(path)
    } catch {
      return undefined
    }
  }
  return resolve(workspace, path)
}

/**
 * The string a pattern is tested against, per tool — the permission
 * request's pattern: the command line for `bash`, the skill name for `skill`,
 * the subagent name for `agent`/`task`, and for the workspace tools the file the path
 * names, relative to the workspace. So `./secrets/a`, `x/../secrets/a` and
 * `/workspace/secrets/a` are all `secrets/a`.
 */
export function permissionSubject(tool: string, args: unknown, workspace: string): string | undefined {
  if (!args || typeof args !== 'object') return undefined
  const key = tool === 'bash' ? 'command' : tool === 'skill' ? 'name' : tool === 'task' || tool === 'agent' ? 'subagent_type' : 'path'
  const value = (args as Record<string, unknown>)[key]
  if (typeof value !== 'string') return undefined
  if (key !== 'path') return value
  const file = toolPath(value, workspace)
  return file === undefined ? undefined : relative(workspace, file) || '.'
}

/**
 * Resolve one tool's rule for this call. `undefined` means "no rule applies".
 * `unparsed` is a bash line that `bashCommands` could not split.
 */
function resolveRule(config: PermissionRuleConfig | undefined, subject: string | undefined, unparsed?: string): PermissionRule | undefined {
  if (config === undefined || typeof config === 'string') return config
  if (subject !== undefined) return matchPatterns(subject, config)
  // No subject to test the specific patterns against. A restriction we cannot
  // evaluate must never silently degrade to `allow`.
  if (Object.entries(config).some(([pattern, rule]) => pattern !== '*' && rule !== 'allow' && mayMatchUnparsed(pattern, unparsed))) return 'ask'
  return config['*']
}

/**
 * Whether a restricted pattern can match a command of a line that does not
 * parse. A pattern matches from a command's first word (`wildcardMatch` is
 * anchored), so `rm *` cannot match a line in which `rm` is not a word. A
 * pattern whose first word holds a wildcard, or no line at all, may match.
 */
function mayMatchUnparsed(pattern: string, unparsed: string | undefined): boolean {
  const word = pattern.trim().split(/\s/)[0]!
  if (unparsed === undefined || !word || /[*?]/.test(word)) return true
  const escaped = word.replaceAll('\\', '/').replace(/[.+^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?<![\\w./-])${escaped}(?![\\w.-])`).test(unparsed.replaceAll('\\', '/'))
}

/**
 * pi's tools whose name is not their capability: `write` and the Kortix tools
 * that write files (`KORTIX_EDIT_TOOLS`) are `edit`; the search and scrape
 * tools reach the web; `workflow` starts subagents, as `task` does.
 */
const TOOL_CAPABILITY: Record<string, RuntimePermissionCapability> = {
  write: 'edit',
  workflow: 'task',
  web_search: 'websearch',
  image_search: 'websearch',
  scrape_webpage: 'webfetch',
  ...Object.fromEntries(KORTIX_EDIT_TOOLS.map((tool) => [tool, 'edit' as const])),
}

/**
 * The capability a permission rule names for this call (`RUNTIME_PERMISSION_CAPABILITIES`); any other tool is its own.
 * `memory` (a project's ejected copy of the retired Kortix tool): `view` only reads, so it is `read`; its other commands are `edit`.
 */
export function toolCapability(tool: string, args?: unknown): string {
  if (tool === 'memory') return (args as { command?: unknown } | null | undefined)?.command === 'view' ? 'read' : 'edit'
  return TOOL_CAPABILITY[tool] ?? tool
}

/**
 * One call's rule under `policy`. Every key that names the tool or its
 * capability (`*` and `pty_*` are patterns too) is tried most specific first;
 * the first that has a rule for this call decides. `undefined` means the
 * policy says nothing.
 *
 * A bash line is decided command by command (`bashCommands`), and the
 * strictest answer wins: `allowed x; env` is the rule for `env`,
 * never the allowed prefix's. A line that does not parse asks when a
 * restricted pattern may match one of its commands (`mayMatchUnparsed`), and
 * otherwise takes the `*` rule.
 *
 * A file tool whose path leaves the workspace also answers to
 * `external_directory`, and the strictest of the two rules wins.
 */
export function resolvePolicyRule(policy: PermissionPolicy, tool: string, args: unknown, workspace: string): PermissionRule | undefined {
  const line = tool === 'bash' ? permissionSubject(tool, args, workspace) : undefined
  if (line === undefined) return strictest([resolveCall(policy, tool, args, workspace), externalRule(policy, tool, args, workspace)])
  const commands = bashCommands(line)
  if (commands === null) return resolveKeys(policy, [tool, toolCapability(tool, {})], undefined, line)
  if (commands.length === 0) return resolveCall(policy, tool, args, workspace)
  return strictest(commands.map((command) => resolveCall(policy, tool, { ...(args as object), command }, workspace)))
}

const strictest = (rules: (PermissionRule | undefined)[]) => (['deny', 'ask', 'allow'] as const).find((rule) => rules.includes(rule))

function resolveCall(policy: PermissionPolicy, tool: string, args: unknown, workspace: string): PermissionRule | undefined {
  return resolveKeys(policy, [tool, toolCapability(tool, args)], permissionSubject(tool, args, workspace))
}

function resolveKeys(policy: PermissionPolicy, names: string[], subject: string | undefined, unparsed?: string): PermissionRule | undefined {
  const keys = Object.keys(policy)
    .filter((key) => names.some((name) => wildcardMatch(name, key)))
    .sort((a, b) => comparePatterns(b, a))
  for (const key of keys) {
    const rule = resolveRule(policy[key], subject, unparsed)
    if (rule !== undefined) return rule
  }
  return undefined
}

/** pi's tools that the `external_directory` check covers; glob and grep take a directory. */
const FILE_TOOLS = new Set(['read', 'write', 'edit', 'glob', 'grep'])

/**
 * The `external_directory` rule for a file tool whose path leaves the
 * workspace. The subject is the directory glob `<dir>/*`. `undefined` inside
 * the workspace, and when the policy has no rule for it: pi does not ask by
 * default.
 */
function externalRule(policy: PermissionPolicy, tool: string, args: unknown, workspace: string): PermissionRule | undefined {
  const raw = (args as { path?: unknown } | null | undefined)?.path
  const file = FILE_TOOLS.has(tool) && typeof raw === 'string' ? toolPath(raw, workspace) : undefined
  if (file === undefined) return undefined
  const inside = relative(workspace, file)
  if (inside !== '..' && !inside.startsWith('../')) return undefined
  return resolveKeys(policy, ['external_directory'], join(tool === 'glob' || tool === 'grep' ? file : dirname(file), '*'))
}

/**
 * Whether an agent may see a skill. The manifest `skills:` grant compiles to
 * the `permission.skill` rule; only a `deny` hides a skill. pi has no
 * skill tool to gate on load, so an `ask` skill stays listed.
 */
export function skillGranted(policy: PermissionPolicy, name: string): boolean {
  // A skill subject is its name, never a path, so no workspace is read.
  return resolvePolicyRule(policy, 'skill', { name }, '/') !== 'deny'
}

/** One rule of the session ruleset (`PATCH /session/:id` `permission`). */
export interface SessionPermissionRule {
  permission?: unknown
  pattern?: unknown
  action?: unknown
}

/** A request waiting for its answer, as the session log's `pending` lists it (`PendingSchema`). */
export interface PendingRecord {
  id: string
  thread_id: string
  call_id?: string
  payload: Record<string, unknown>
  asked_at: string
}

/**
 * What apps/api answers when the runtime reports an ask (`POST /turn-question`,
 * `POST /turn-permission`, `@kortix/api-contract/runtime-relay`). Null: the
 * relay failed, and the ask waits `DEFAULT_LIVE_WAIT_MS` before it parks.
 */
export interface AskRelayAnswer {
  /** How long the call waits for a live answer before it parks. 0: park at once (nobody watches). */
  liveWaitMs?: number
  /** Permission: a person approved this exact call (same `argsHash`) earlier, so it runs now. */
  approved?: boolean
  /** Permission: the capability that approval granted for the rest of the session ("always"). */
  grant?: string
  /** Question: answers that release the call at once (a chat channel posts the question and the reply is a new turn). */
  answers?: string[][]
}

/**
 * How long an ask holds its tool call for a live answer before it parks. A
 * person at the keyboard answers within this window and the turn goes on as
 * before; past it, the ask waits in Review and the turn moves on.
 */
export const DEFAULT_LIVE_WAIT_MS = 180_000

/** The call's outcome when it parked: the ask stays open in apps/api, and its answer arrives as a new message. */
export const PARKED = 'parked' as const
export type Parked = typeof PARKED

/** The key an approval and the agent's re-run of the same call share: the tool and its canonical arguments. */
export function permissionArgsHash(tool: string, args: unknown): string {
  return createHash('sha256').update(`${tool}\n${canonicalJson(args ?? null)}`).digest('hex')
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

/** Park the entry after `ms` (none: the default window). The timer never holds the process open. */
function liveWaitTimer(ms: number | undefined, park: () => void): ReturnType<typeof setTimeout> | undefined {
  const wait = typeof ms === 'number' && Number.isFinite(ms) ? Math.max(0, ms) : DEFAULT_LIVE_WAIT_MS
  if (wait === 0) {
    queueMicrotask(park)
    return undefined
  }
  const timer = setTimeout(park, wait)
  timer.unref?.()
  return timer
}

type PermissionEntry = {
  request: RuntimePermissionRequest
  resolve: (reply: PermissionReply | Parked) => void
  askedAt: string
  /** `relaying`: registered, apps/api not answered yet, nothing on the wire. `asked`: published, waiting for a person. */
  phase: 'relaying' | 'asked'
  timer?: ReturnType<typeof setTimeout>
}

type QuestionEntry = {
  request: RuntimeQuestionRequest
  resolve: (answers: string[][] | null | Parked) => void
  askedAt: string
  parkable: boolean
  timer?: ReturnType<typeof setTimeout>
}

export class PermissionBroker {
  private readonly pending = new Map<string, PermissionEntry>()
  /** Capabilities allowed for the rest of the session: an "always" reply, or the session ruleset (`*`: every one). */
  private readonly granted = new Set<string>()

  constructor(
    private readonly sessionID: string,
    /** The directory the file tools resolve paths against. */
    private readonly workspace: string,
    private readonly publish: (frame: RuntimeFrame) => void,
    private policy: PermissionPolicy = {},
    /**
     * Reports the ask to apps/api before anyone sees it: apps/api stores it, says how long it may
     * wait live, and releases a call a person already approved (`AskRelayAnswer`).
     */
    private readonly relay?: (request: RuntimePermissionRequest, call: { tool: string; argsHash: string }) => Promise<AskRelayAnswer | null>,
    /** A request was asked or answered, or the grants changed: the pending list moved. */
    private readonly onChange?: () => void,
  ) {}

  setPolicy(policy: PermissionPolicy): void {
    this.policy = policy
  }

  rule(tool: string, args?: unknown): PermissionRule {
    const resolved = resolvePolicyRule(this.policy, tool, args, this.workspace)
    // A deny outranks an earlier "always": approving `ls` must not unlock the
    // `rm -rf *` the same pattern map denies.
    if (resolved === 'deny') return 'deny'
    if (this.grants(tool, args)) return 'allow'
    return resolved ?? 'allow'
  }

  /** The session's grants cover this call's capability. A policy `deny` still outranks them (`rule`). */
  grants(tool: string, args?: unknown): boolean {
    return this.granted.has('*') || this.granted.has(toolCapability(tool, args))
  }

  /**
   * Replace the session's grants with the session ruleset: each `allow` rule over every pattern
   * grants its capability (`*`: all of them). An empty list clears every grant, "always" replies
   * included. A rule for one pattern, or any other action, grants nothing.
   */
  setSessionRules(rules: readonly SessionPermissionRule[]): void {
    this.setGrants(
      rules.flatMap((rule) =>
        rule?.action === 'allow' && typeof rule.permission === 'string' && (rule.pattern === undefined || rule.pattern === '*') ? [rule.permission] : [],
      ),
    )
  }

  /** Replace the session's grants: each capability (`*`: all) is allowed without asking. `[]` clears them. */
  setGrants(grants: readonly string[]): void {
    this.granted.clear()
    for (const grant of grants) this.granted.add(grant)
  }

  /** The grants, as the runtime's dump keeps them. */
  grantList(): string[] {
    return [...this.granted]
  }

  restoreGrants(grants: readonly string[]): void {
    for (const grant of grants) if (typeof grant === 'string') this.granted.add(grant)
  }

  /**
   * Resolves with the person's reply, or `PARKED` when nobody answered live: the
   * call does not run, the ask stays open in apps/api, and an approval reaches
   * the agent as a new message. Never rejects.
   */
  async ask(input: { tool: string; args: unknown; ref?: RuntimeToolRef }): Promise<PermissionReply | Parked> {
    const request: RuntimePermissionRequest = {
      id: `perm_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
      sessionID: this.sessionID,
      // The capability, so "always" covers every tool that shares it (`write` and `edit`).
      permission: toolCapability(input.tool, input.args),
      patterns: [permissionSubject(input.tool, input.args, this.workspace) ?? '*'],
      metadata: input.args && typeof input.args === 'object' ? (input.args as Record<string, unknown>) : {},
      always: ['*'],
      ...(input.ref ? { tool: input.ref } : {}),
    }
    // Registered BEFORE the relay, as QuestionBroker does: a Stop, a steer or a turn end
    // during the relay (`parkAll`) parks this ask instead of missing it.
    let entry!: PermissionEntry
    const settled = new Promise<PermissionReply | Parked>((resolve) => {
      entry = { request, resolve, askedAt: new Date().toISOString(), phase: 'relaying' }
    })
    this.pending.set(request.id, entry)
    const relayed = this.relay
      ? await this.relay(request, { tool: input.tool, argsHash: permissionArgsHash(input.tool, input.args) }).catch(() => null)
      : null
    // Parked during the relay: the call does not run, the ask stays open in apps/api.
    if (this.pending.get(request.id) !== entry) return settled
    if (relayed?.approved) {
      // The re-run of a call a person approved while it was parked.
      this.take(request.id)
      if (relayed.grant) {
        this.granted.add(relayed.grant)
        this.onChange?.()
      }
      return 'once'
    }
    entry.phase = 'asked'
    this.publish({ type: 'permission.asked', properties: { ...request } })
    this.onChange?.()
    entry.timer = liveWaitTimer(relayed?.liveWaitMs, () => void this.park(request.id))
    return settled
  }

  reply(id: string, reply: PermissionReply): boolean {
    const entry = this.take(id)
    if (!entry) return false
    if (reply === 'always') this.granted.add(entry.request.permission)
    this.publish({ type: 'permission.replied', properties: { sessionID: this.sessionID, requestID: id, reply } })
    entry.resolve(reply)
    this.onChange?.()
    return true
  }

  /** Stop holding the call: it resolves `PARKED`, and the request stays open in apps/api. */
  park(id: string): boolean {
    const entry = this.take(id)
    if (!entry) return false
    // A relaying ask was never on the wire: nothing to withdraw there.
    if (entry.phase === 'asked') this.publish({ type: 'permission.parked', properties: { sessionID: this.sessionID, requestID: id } })
    entry.resolve(PARKED)
    if (entry.phase === 'asked') this.onChange?.()
    return true
  }

  parkAll(): number {
    const ids = [...this.pending.keys()]
    for (const id of ids) this.park(id)
    return ids.length
  }

  private take(id: string): PermissionEntry | undefined {
    const entry = this.pending.get(id)
    if (!entry) return undefined
    this.pending.delete(id)
    if (entry.timer) clearTimeout(entry.timer)
    return entry
  }

  /** The asks a person can answer: a relaying one is not on the wire yet. */
  private asked(): PermissionEntry[] {
    return [...this.pending.values()].filter((entry) => entry.phase === 'asked')
  }

  list(): RuntimePermissionRequest[] {
    return this.asked().map((entry) => entry.request)
  }

  /** The open requests, as the session log's `pending.permissions`. */
  records(): PendingRecord[] {
    return this.asked().map(({ request, askedAt }) => ({
      id: request.id,
      thread_id: request.sessionID,
      ...(request.tool?.callID ? { call_id: request.tool.callID } : {}),
      payload: { permission: request.permission, patterns: request.patterns, always: request.always, metadata: request.metadata },
      asked_at: askedAt,
    }))
  }

}

export class QuestionBroker {
  private readonly pending = new Map<string, QuestionEntry>()

  constructor(
    private readonly sessionID: string,
    private readonly publish: (frame: RuntimeFrame) => void,
    /**
     * Reports the question to apps/api, which stores it and says how long it may wait live
     * (`AskRelayAnswer`), or releases it at once with answers (a chat channel).
     */
    private readonly relay?: (request: RuntimeQuestionRequest, ask: { parkable: boolean }) => Promise<AskRelayAnswer | null>,
    /** A question was asked, answered, dismissed or parked: the pending list moved. */
    private readonly onChange?: () => void,
  ) {}

  /**
   * Resolves with the answers; null when dismissed; `PARKED` when nobody answered live and the
   * question waits in apps/api (its answer arrives as a new message). A question that is not
   * `parkable` (a workflow run approval) resolves null where another one parks. Never rejects.
   */
  ask(questions: RuntimeQuestion[], ref?: RuntimeToolRef, options: { parkable?: boolean } = {}): Promise<string[][] | null | Parked> {
    const parkable = options.parkable !== false
    const request: RuntimeQuestionRequest = {
      id: `que_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
      sessionID: this.sessionID,
      questions,
      ...(ref ? { tool: ref } : {}),
    }
    return new Promise((resolve) => {
      const entry: QuestionEntry = { request, resolve, askedAt: new Date().toISOString(), parkable }
      this.pending.set(request.id, entry)
      this.publish({ type: 'question.asked', properties: { ...request } })
      this.onChange?.()
      const relayed = this.relay ? this.relay(request, { parkable }).catch(() => null) : Promise.resolve(null)
      void relayed.then((answer) => {
        if (this.pending.get(request.id) !== entry) return
        if (answer?.answers) {
          this.reply(request.id, answer.answers)
          return
        }
        entry.timer = liveWaitTimer(answer?.liveWaitMs, () => void this.park(request.id))
      })
    })
  }

  reply(id: string, answers: string[][]): boolean {
    const entry = this.take(id)
    if (!entry) return false
    this.publish({ type: 'question.replied', properties: { sessionID: this.sessionID, requestID: id, answers } })
    entry.resolve(answers)
    this.onChange?.()
    return true
  }

  reject(id: string): boolean {
    const entry = this.take(id)
    if (!entry) return false
    this.publish({ type: 'question.rejected', properties: { sessionID: this.sessionID, requestID: id } })
    entry.resolve(null)
    this.onChange?.()
    return true
  }

  /** Stop holding the call. A parkable question stays open in apps/api; another one is dismissed. */
  park(id: string): boolean {
    const entry = this.pending.get(id)
    if (!entry) return false
    if (!entry.parkable) return this.reject(id)
    this.take(id)
    this.publish({ type: 'question.parked', properties: { sessionID: this.sessionID, requestID: id } })
    entry.resolve(PARKED)
    this.onChange?.()
    return true
  }

  parkAll(): number {
    const ids = [...this.pending.keys()]
    for (const id of ids) this.park(id)
    return ids.length
  }

  list(): RuntimeQuestionRequest[] {
    return [...this.pending.values()].map((entry) => entry.request)
  }

  /** The open questions, as the session log's `pending.questions`. */
  records(): PendingRecord[] {
    return [...this.pending.values()].map(({ request, askedAt }) => ({
      id: request.id,
      thread_id: request.sessionID,
      ...(request.tool?.callID ? { call_id: request.tool.callID } : {}),
      payload: { questions: request.questions },
      asked_at: askedAt,
    }))
  }

  private take(id: string): QuestionEntry | undefined {
    const entry = this.pending.get(id)
    if (!entry) return undefined
    this.pending.delete(id)
    if (entry.timer) clearTimeout(entry.timer)
    return entry
  }
}
