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
  const output = valueText(tool.rawOutput) || contentText(tool.content);
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
 * renderer identity every host's tool components dispatch on. Falls back to
 * an explicit `data.tool`/`data.name` hint, then `'acp_tool'`.
 */
export function acpToolName(tool: AcpToolCall): string {
  const hint = `${tool.toolKind ?? ''} ${tool.title}`.toLowerCase();
  if (/execute|terminal|shell|command|bash/.test(hint)) return 'bash';
  if (/apply.?patch|diff|patch/.test(hint)) return 'apply_patch';
  if (/write|create file/.test(hint)) return 'write';
  if (/edit|replace/.test(hint)) return 'edit';
  if (/read|view file/.test(hint)) return 'read';
  if (/glob|find files/.test(hint)) return 'glob';
  if (/search|grep/.test(hint)) return 'grep';
  if (/fetch|http|web/.test(hint)) return 'webfetch';
  const explicit = tool.data.tool ?? tool.data.name;
  return typeof explicit === 'string' && explicit ? explicit : 'acp_tool';
}

function statusFor(status: string | null): 'pending' | 'running' | 'completed' | 'error' {
  if (status === 'failed' || status === 'error') return 'error';
  if (status === 'completed') return 'completed';
  if (status === 'in_progress' || status === 'running') return 'running';
  return 'pending';
}

function normalizeInput(value: unknown, name: string, locations: unknown[]): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === 'string') return name === 'bash' ? { command: value } : { value };
  const first = locations.find((location) => location && typeof location === 'object') as Record<string, unknown> | undefined;
  const path = first?.path ?? first?.uri;
  return typeof path === 'string' ? { filePath: path } : {};
}

function contentText(content: unknown[]): string {
  return content.map((entry) => {
    if (typeof entry === 'string') return entry;
    if (!entry || typeof entry !== 'object') return '';
    const record = entry as Record<string, unknown>;
    return valueText(record.text ?? record.content ?? record.output);
  }).filter(Boolean).join('\n');
}

function valueText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
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
