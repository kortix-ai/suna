import type { AcpToolCall } from './transcript';

/**
 * Harness-neutral normalization of an `AcpToolCall` into the shape every
 * host renders through — deliberately WITHOUT the host-scoped fields
 * (`sessionID`, `messageID`, `type`) a `ToolPart` needs. Hosts add those at
 * the boundary; the SDK never invents a session id.
 */
export type AcpNormalizedToolPart = {
  id: string;
  callID: string;
  tool: string;
  state: {
    status: 'pending' | 'running' | 'completed' | 'error';
    input: Record<string, unknown>;
    output: string;
    error?: string;
    metadata: { locations: unknown[]; acp: Record<string, unknown> };
  };
};

/** Normalizes one ACP tool call for rendering. See `AcpNormalizedToolPart`. */
export function acpToolCallToPart(tool: AcpToolCall): AcpNormalizedToolPart {
  const name = acpToolName(tool);
  const input = normalizeInput(tool.rawInput, name, tool.locations);
  const output = stripProcessPlumbing(valueText(tool.rawOutput) || contentText(tool.content));
  const status = statusFor(tool.status);
  const state = status === 'error'
    ? { status, input, output, error: output || `${tool.title} failed`, metadata: { locations: tool.locations, acp: tool.data } }
    : { status, input, output, metadata: { locations: tool.locations, acp: tool.data } };
  return {
    id: `acp-tool:${tool.id}`,
    callID: tool.id,
    tool: name,
    state,
  };
}

/**
 * Maps an ACP tool call's title/kind (vendor-specific, free text) onto the
 * renderer identity every host's tool components dispatch on.
 *
 * A harness that *declares* its tool's name is trusted first: the MCP-style
 * `rawInput: { name, arguments }` wrapper (codex uses it for its non-native
 * tools) carries the tool's real identity, so it wins over the free-text
 * substring guesses below. Without this, a title that merely *contains* a
 * verb hijacks the call — codex's `write_stdin` (a PTY-poll tool with no file
 * path) was read as `'write'` by the `/write/` check, misfiled into the
 * `edit` family, and dropped from both the Context and Outputs cards. The
 * substring guesses remain the fallback for ACP-native calls that arrive with
 * only a title/kind and no declared name (the read/edit/execute path).
 *
 * Falls back to an explicit `data.tool`/`data.name` hint, then `'acp_tool'`.
 */
export function acpToolName(tool: AcpToolCall): string {
  const declared = declaredToolName(tool.rawInput);
  if (declared) return declared;

  const hint = `${tool.toolKind ?? ''} ${tool.title}`.toLowerCase();
  if (/execute|terminal|shell|command|bash/.test(hint)) return 'bash';
  if (/apply.?patch|diff|patch/.test(hint)) return 'apply_patch';
  if (/write|create file/.test(hint)) return 'write';
  if (/edit|replace/.test(hint)) return 'edit';
  if (/read|view file/.test(hint)) return 'read';
  if (/glob|find files/.test(hint)) return 'glob';
  // A native web search must reach the `web` family — check it (and any
  // fetch/http/web hint) BEFORE the generic `/search|grep/`, which would
  // otherwise claim "web search" as a code grep. A non-web "search"-flavored
  // title (an MCP `ToolSearch`, a repo grep) has no web/fetch/http token and
  // still falls through to `grep`.
  if (/web.?search|websearch/.test(hint)) return 'websearch';
  if (/fetch|http|web/.test(hint)) return 'webfetch';
  if (/search|grep/.test(hint)) return 'grep';
  const explicit = tool.data.tool ?? tool.data.name;
  return typeof explicit === 'string' && explicit ? explicit : 'acp_tool';
}

/**
 * The harness's own declared tool name, if the call carries an MCP-style
 * `{ name, arguments }` wrapper in its `rawInput`. The `arguments` sibling is
 * required so a genuine tool that merely has a `name` *argument* (e.g.
 * `project_create({ name, description })`) is not mistaken for the wrapper —
 * only the real envelope shape (`{ name: "write_stdin", arguments: {…} }`)
 * qualifies. Returns `undefined` for the ACP-native shape (a bare
 * `{ command }` / `{ file_path, … }` input), leaving classification to the
 * title/kind heuristics.
 */
function declaredToolName(rawInput: unknown): string | undefined {
  if (!rawInput || typeof rawInput !== 'object' || Array.isArray(rawInput)) return undefined;
  const record = rawInput as Record<string, unknown>;
  const name = record.name;
  const hasArguments = record.arguments !== undefined && typeof record.arguments === 'object';
  return hasArguments && typeof name === 'string' && name ? name : undefined;
}

function statusFor(status: string | null): 'pending' | 'running' | 'completed' | 'error' {
  if (status === 'failed' || status === 'error') return 'error';
  if (status === 'completed') return 'completed';
  if (status === 'in_progress' || status === 'running') return 'running';
  return 'pending';
}

function normalizeInput(value: unknown, name: string, locations: unknown[]): Record<string, unknown> {
  let input: Record<string, unknown>;
  if (value && typeof value === 'object' && !Array.isArray(value)) input = { ...(value as Record<string, unknown>) };
  else if (typeof value === 'string') input = name === 'bash' ? { command: value } : { value };
  else input = {};
  // Canonical `filePath` for the camelCase key every host renderer dispatches
  // on (`getToolInfo`): ACP harnesses send snake_case (`file_path`, Claude
  // Code / claude-agent-acp) or only report the file through `locations`.
  // The original keys stay untouched alongside the alias.
  if (typeof input.filePath !== 'string') {
    const aliased = firstStringOf(input.file_path, input.abs_path, input.absolute_path, input.filename);
    if (aliased) input.filePath = aliased;
    else {
      const first = locations.find((location) => location && typeof location === 'object') as Record<string, unknown> | undefined;
      const path = first?.path ?? first?.uri;
      if (typeof path === 'string') input.filePath = path;
    }
  }
  return input;
}

function contentText(content: unknown[]): string {
  return content.map((entry) => {
    if (typeof entry === 'string') return entry;
    if (!entry || typeof entry !== 'object') return '';
    const record = entry as Record<string, unknown>;
    // Diff/terminal content blocks are structured, not prose — hosts render
    // them from `metadata.acp`/the raw tool call, never as flattened text.
    if (record.type === 'diff' || record.type === 'terminal') return '';
    return valueText(record.text ?? record.content ?? record.output);
  }).filter(Boolean).join('\n');
}

function valueText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  if (typeof value === 'object' && !Array.isArray(value)) {
    // Structured tool outputs (e.g. claude-agent-acp's bash
    // `{ formatted_output, exit_code }`, or a nested `{ text }` content
    // block) carry their human-readable text under a well-known key —
    // surface THAT, never a `JSON.stringify` dump of the whole envelope.
    const record = value as Record<string, unknown>;
    const text = firstStringOf(
      record.formatted_output,
      record.formattedOutput,
      record.output,
      record.stdout,
      record.stderr,
      record.text,
      record.message,
      record.content,
    );
    if (text) return text;
  }
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

/**
 * The Kortix sandbox wraps long-running shell/tool processes in a status
 * header before the real text:
 *
 *     Chunk ID: ddbbf1
 *     Wall time: 1.0005 seconds
 *     Process running with session ID 16120
 *     Original token count: 0
 *     Output:
 *     <the actual output…>
 *
 * That plumbing is process bookkeeping, not tool output — a non-technical
 * reader should only ever see what the command actually printed. Drop the
 * bookkeeping lines (they may repeat per chunk) and the bare `Output:`
 * label; whatever remains is the real text. An empty remainder is the
 * honest answer "this produced no output", which hosts render as their own
 * quiet empty state rather than a wall of internals.
 */
const PROCESS_PLUMBING_LINE = /^\s*(Chunk ID: \S+|Wall time: [\d.]+ seconds?|Process (?:still )?running with session ID \d+|Original token count: \d+|Output:)\s*$/;

function stripProcessPlumbing(text: string): string {
  if (!text || !/^\s*Chunk ID: /m.test(text)) return text;
  return text
    .split('\n')
    .filter((line) => !PROCESS_PLUMBING_LINE.test(line))
    .join('\n')
    .trim();
}

function firstStringOf(...values: unknown[]): string | undefined {
  for (const candidate of values) {
    if (typeof candidate === 'string' && candidate) return candidate;
  }
  return undefined;
}

/**
 * Coerces string-typed elicitation answers (as collected from form inputs)
 * back onto the JSON types `params.requestedSchema.properties[key].type`
 * declares — `'boolean'` → `true`/`false`, `'number'`/`'integer'` → a finite
 * number. Enum-typed properties (no explicit `type`) and any key absent from
 * the schema pass through as the original string untouched.
 */
export function coerceElicitationAnswers(
  answers: Record<string, string>,
  params: Record<string, unknown>,
): Record<string, unknown> {
  if (!isRecord(answers)) return {};
  const schema = isRecord(params?.requestedSchema) ? params.requestedSchema : null;
  const properties = schema && isRecord(schema.properties) ? schema.properties : null;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(answers)) {
    const property = properties && isRecord(properties[key]) ? (properties[key] as Record<string, unknown>) : null;
    const type = property && typeof property.type === 'string' ? property.type : null;
    if (type === 'boolean') {
      result[key] = value === 'true' ? true : value === 'false' ? false : value;
    } else if (type === 'number' || type === 'integer') {
      const numeric = Number(value);
      result[key] = Number.isFinite(numeric) ? numeric : value;
    } else {
      result[key] = value;
    }
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
