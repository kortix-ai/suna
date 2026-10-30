/**
 * The My Kortix platform tools' result, parsed defensively.
 *
 * The shape is `KortixToolResult` in `packages/api-contract/src/kortix-tool-card.ts`.
 * `@kortix/ui` does not depend on that package, so the types are mirrored here
 * and every field is checked. A result that does not parse is `null`, and the
 * call renders as the generic tool card instead of a half-drawn one.
 */

/** `KORTIX_PLATFORM_TOOL_NAMES` in `packages/api-contract/src/kortix-tool-card.ts`. */
export const KORTIX_PLATFORM_TOOLS = [
  'kortix_agents',
  'kortix_sessions',
  'kortix_schedules',
  'kortix_connectors',
  'kortix_people',
  'kortix_access',
  'kortix_usage',
] as const;
export type KortixPlatformTool = (typeof KORTIX_PLATFORM_TOOLS)[number];

/**
 * The multi-agent tools (`packages/api-contract/src/multi-agent.ts`): the same
 * `KortixToolResult`, with `data` = the contract object the card body draws.
 * `task_create`, `task_list`, `task_get` and `task_update` are also the names of
 * older plugin tools: `multi-agent-tools.tsx` tells the two apart by the output.
 */
export const MULTI_AGENT_TOOLS = [
  'send_message',
  'list_agents',
  'task_create',
  'task_list',
  'task_get',
  'task_update',
  'task_stop',
] as const;
export type MultiAgentTool = (typeof MULTI_AGENT_TOOLS)[number];

/** Every tool whose result is a `KortixToolResult` card. */
export type KortixCardTool = KortixPlatformTool | MultiAgentTool;

export type KortixCardStatus = 'done' | 'running' | 'needs_you' | 'denied' | 'error';

export interface KortixCardRow {
  title: string;
  detail?: string;
  badge?: string;
  /** In-app path (`/projects/…`). A row never links outside the app. */
  href?: string;
}

/** A `before` of `null` is a new setting; an `after` of `null` is a removed one. */
export interface KortixCardChange {
  field: string;
  before: string | null;
  after: string | null;
}

export interface KortixCardLink {
  label: string;
  /** An in-app path, or an absolute `https://` URL (a connector sign-in link). */
  href: string;
  /** True for an absolute `https://` URL: it opens in a new tab and is the card's primary action. */
  external: boolean;
}

export interface KortixToolCard {
  title: string;
  subtitle?: string;
  status: KortixCardStatus;
  rows: KortixCardRow[];
  changes: KortixCardChange[];
  links: KortixCardLink[];
}

export interface KortixGrantor {
  name: string;
  role: string;
}

export interface KortixToolError {
  kind: 'denied' | 'not_found' | 'invalid' | 'failed';
  message: string;
  grantors: KortixGrantor[];
}

export interface KortixToolResult {
  ok: boolean;
  tool: KortixCardTool;
  action: string;
  card: KortixToolCard;
  error?: KortixToolError;
  /** What the model reads. Only the multi-agent card bodies draw it, each through its own defensive parser. */
  data?: unknown;
}

const STATUSES = new Set<KortixCardStatus>(['done', 'running', 'needs_you', 'denied', 'error']);
const ERROR_KINDS = new Set<KortixToolError['kind']>(['denied', 'not_found', 'invalid', 'failed']);
/** A card holds a short list; a longer one is the tool's mistake, not a page to render. */
const MAX_ITEMS = 50;

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

/** The platform tool a call name names: `kortix_agents`, also as `kortix-agents` or `oc-kortix_agents`. */
export function kortixPlatformTool(name: string): KortixPlatformTool | undefined {
  const normalized = name.replace(/^oc[-_]/, '').replace(/-/g, '_');
  return (KORTIX_PLATFORM_TOOLS as readonly string[]).includes(normalized)
    ? (normalized as KortixPlatformTool)
    : undefined;
}

/** A multi-agent tool a call name names: `send_message`, also as `send-message` or `oc-send_message`. */
export function multiAgentTool(name: string): MultiAgentTool | undefined {
  const normalized = name.replace(/^oc[-_]/, '').replace(/-/g, '_');
  return (MULTI_AGENT_TOOLS as readonly string[]).includes(normalized) ? (normalized as MultiAgentTool) : undefined;
}

/** Any tool that answers with a `KortixToolResult` card. */
export function kortixCardTool(name: string): KortixCardTool | undefined {
  return kortixPlatformTool(name) ?? multiAgentTool(name);
}

/** An in-app path: one leading `/`, never `//` (a protocol-relative URL leaves the app). */
export function inAppHref(value: unknown): string | undefined {
  const href = text(value);
  return href && href.startsWith('/') && !href.startsWith('//') && !href.includes('\\') ? href : undefined;
}

function externalHref(value: unknown): string | undefined {
  const href = text(value);
  if (!href) return undefined;
  try {
    return new URL(href).protocol === 'https:' ? href : undefined;
  } catch {
    return undefined;
  }
}

function list<T>(value: unknown, item: (entry: unknown) => T | undefined): T[] {
  if (!Array.isArray(value)) return [];
  const out: T[] = [];
  for (const entry of value.slice(0, MAX_ITEMS)) {
    const parsed = item(entry);
    if (parsed !== undefined) out.push(parsed);
  }
  return out;
}

function row(entry: unknown): KortixCardRow | undefined {
  if (!isObject(entry)) return undefined;
  const title = text(entry.title);
  if (!title) return undefined;
  const detail = text(entry.detail);
  const badge = text(entry.badge);
  const href = inAppHref(entry.href);
  return { title, ...(detail ? { detail } : {}), ...(badge ? { badge } : {}), ...(href ? { href } : {}) };
}

const setting = (value: unknown): string | null | undefined =>
  value === null ? null : typeof value === 'string' ? value : typeof value === 'number' || typeof value === 'boolean' ? String(value) : undefined;

function change(entry: unknown): KortixCardChange | undefined {
  if (!isObject(entry)) return undefined;
  const field = text(entry.field);
  const before = setting(entry.before);
  const after = setting(entry.after);
  if (!field || before === undefined || after === undefined || (before === null && after === null)) return undefined;
  return { field, before, after };
}

function link(entry: unknown): KortixCardLink | undefined {
  if (!isObject(entry)) return undefined;
  const label = text(entry.label);
  if (!label) return undefined;
  const internal = inAppHref(entry.href);
  if (internal) return { label, href: internal, external: false };
  const external = externalHref(entry.href);
  return external ? { label, href: external, external: true } : undefined;
}

function grantor(entry: unknown): KortixGrantor | undefined {
  if (!isObject(entry)) return undefined;
  const name = text(entry.name);
  return name ? { name, role: text(entry.role) ?? '' } : undefined;
}

function toolError(value: unknown): KortixToolError | undefined {
  if (!isObject(value) || !ERROR_KINDS.has(value.kind as KortixToolError['kind'])) return undefined;
  return {
    kind: value.kind as KortixToolError['kind'],
    message: text(value.message) ?? '',
    grantors: list(value.grantors, grantor),
  };
}

/**
 * The result in a platform call's output (or its error text, when the call threw
 * it): one JSON object. `null` when the text is not that object. `callName` names
 * the tool when the result leaves `tool` out.
 */
export function parseKortixToolResult(raw: string | undefined, callName?: string): KortixToolResult | null {
  const source = raw?.trim();
  if (!source || !source.startsWith('{')) return null;
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    return null;
  }
  if (!isObject(value) || typeof value.ok !== 'boolean' || !isObject(value.card)) return null;
  const tool =
    typeof value.tool === 'string' ? kortixCardTool(value.tool) : callName !== undefined ? kortixCardTool(callName) : undefined;
  const title = text(value.card.title);
  if (!tool || !title) return null;
  const error = toolError(value.error);
  // A refusal reads as one whatever status the card names: the error kind is the fact.
  const status: KortixCardStatus = error?.kind === 'denied'
    ? 'denied'
    : STATUSES.has(value.card.status as KortixCardStatus)
      ? (value.card.status as KortixCardStatus)
      : value.ok
        ? 'done'
        : 'error';
  const subtitle = text(value.card.subtitle);
  return {
    ok: value.ok,
    tool,
    action: text(value.action) ?? '',
    card: {
      title,
      ...(subtitle ? { subtitle } : {}),
      status,
      rows: list(value.card.rows, row),
      changes: list(value.card.changes, change),
      links: list(value.card.links, link),
    },
    ...(error ? { error } : {}),
    ...(value.data !== undefined ? { data: value.data } : {}),
  };
}

/** The actions that only read; every other action changes something (the SDK narration uses the same set). */
const READ_ACTIONS = new Set(['', 'list', 'get', 'read', 'find', 'show', 'search', 'check', 'status', 'pending', 'who']);

export function isReadAction(action: unknown): boolean {
  return READ_ACTIONS.has(typeof action === 'string' ? action : '');
}
