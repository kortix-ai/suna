/**
 * Tool-call accessors — the pure helpers every tool renderer starts with. They
 * read a session-log tool call (`ToolCallBlock`), as web's
 * `tool/shared/infrastructure-parts.tsx` does.
 *
 * Ports apps/web `tool/shared/infrastructure.tsx` accessors with IDENTICAL
 * names and semantics (`partInput`, `partOutput`, `partStatus`,
 * `partStreamingInput`, `partMetadata`, `firstMeaningfulLine`,
 * `getAgentCardLabel`, `isLocalSandboxFilePath`), plus web's
 * `lib/markdown-detect.ts` `looksLikeMarkdown` and
 * `components/markdown/markdown-frontmatter.tsx` `parseFrontmatter`.
 *
 * The verdict helpers (`isErrorOutput`, `looksLikeError`, `parseJsonFailure`,
 * `partOutcome`, …) and output formatting already live in `@kortix/sdk` and
 * are re-exported, not re-implemented.
 *
 * No React imports: `components/session/tool/shared/infrastructure.tsx`
 * re-exports this module so renderers keep web's import shape.
 */

import { toolCallMetadata, toolCallRawOutput, type ToolCallBlock } from '@kortix/sdk';

// The SDK's block readers, under the names the renderers use: the status in their words
// (`completed`, not `complete`), the raw output of a completed call, a failed call's error text.
export { toolCallError as partError, toolCallRawOutput as partRawOutput, toolCallStatus as partStatus } from '@kortix/sdk';
import { stripBashMetadata } from '@kortix/shared/tool-output';
import { isHighlightLang, normalizeLanguage } from '@/lib/code-theme';

export {
  cleanErrorMessage,
  formatJsonFailureOutput,
  formatRawOutput,
  isErrorOutput,
  looksLikeError,
  looksLikeJsonPayload,
  parseJsonFailure,
  partOutcome,
} from '@kortix/sdk';
export type { ParsedJsonFailure, ToolOutcome } from '@kortix/sdk';

/** Best-effort parse of a JSON object that is still streaming in. */
export function parsePartialJSON(raw: string): Record<string, unknown> {
  if (!raw) return {};

  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null) return parsed;
  } catch {}

  try {
    let attempt = raw.trim();
    let braces = 0;
    let brackets = 0;
    let inString = false;
    let escape = false;
    for (const ch of attempt) {
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === '\\') {
        escape = true;
        continue;
      }
      if (ch === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (ch === '{') braces++;
      if (ch === '}') braces--;
      if (ch === '[') brackets++;
      if (ch === ']') brackets--;
    }
    if (inString) attempt += '"';
    for (let i = 0; i < brackets; i++) attempt += ']';
    for (let i = 0; i < braces; i++) attempt += '}';
    const parsed = JSON.parse(attempt);
    if (typeof parsed === 'object' && parsed !== null) return parsed;
  } catch {}

  const result: Record<string, unknown> = {};
  const re = /"(\w+)"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    result[m[1]] = m[2].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  return result;
}

/**
 * The one empty object every "no input / no metadata yet" answer shares, so a
 * `useMemo([input])` downstream can hold. Frozen: mutating it fails loudly.
 */
const EMPTY_RECORD: Record<string, unknown> = Object.freeze({});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isEmptyObject(value: Record<string, unknown>): boolean {
  for (const key in value) {
    if (Object.prototype.hasOwnProperty.call(value, key)) return false;
  }
  return true;
}

/**
 * While a call streams, its `input` is the arguments so far: an object, or the
 * text so far (partial JSON). A call block is replaced, never mutated, when it
 * changes, so its identity is the version and one parse per block is kept.
 */
const STREAMING_INPUT_CACHE = new WeakMap<ToolCallBlock, Record<string, unknown>>();

/** A call's arguments, including the half-arrived ones — memoised per call. */
export function partStreamingInput(call: ToolCallBlock): Record<string, unknown> {
  const input = call.input;
  if (isRecord(input)) return isEmptyObject(input) ? EMPTY_RECORD : input;
  if (typeof input !== 'string' || !input) return EMPTY_RECORD;
  const cached = STREAMING_INPUT_CACHE.get(call);
  if (cached) return cached;
  const parsed = parsePartialJSON(input);
  STREAMING_INPUT_CACHE.set(call, parsed);
  return parsed;
}

export function partInput(call: ToolCallBlock): Record<string, unknown> {
  return partStreamingInput(call);
}

/** The harness's display metadata of a call that has started (`toolCallMetadata`). */
export function partMetadata(call: ToolCallBlock): Record<string, unknown> {
  return call.status === 'pending' ? EMPTY_RECORD : toolCallMetadata(call);
}

const OUTPUT_CACHE = new WeakMap<ToolCallBlock, string>();

/** A completed tool's output, stripped of transport noise — memoised per call. */
export function partOutput(call: ToolCallBlock): string {
  if (call.status !== 'complete') return '';

  const cached = OUTPUT_CACHE.get(call);
  if (cached !== undefined) return cached;

  const output = stripBashMetadata(toolCallRawOutput(call))
    .replace(/<\/?(?:system_info|exit_code|stderr_note)>[\s\S]*?(?:<\/\w+>)?$/g, '')
    .trim();

  OUTPUT_CACHE.set(call, output);
  return output;
}

export function firstMeaningfulLine(value: unknown, maxLength = 120): string {
  if (typeof value !== 'string') return '';
  const line = value
    .split('\n')
    .map((segment) => segment.trim())
    .find(Boolean);
  if (!line) return '';
  return line.length > maxLength ? `${line.slice(0, maxLength).trim()}…` : line;
}

export function getAgentCardLabel(input: Record<string, unknown>): string {
  const title = firstMeaningfulLine(input.title, 80);
  if (title) return title;
  const description = firstMeaningfulLine(input.description);
  if (description) return description;
  const message = firstMeaningfulLine(input.message);
  if (message) return message;
  const promptPreview = firstMeaningfulLine(input.prompt);
  if (promptPreview) return promptPreview;
  const agentId = firstMeaningfulLine(input.agent_id, 40);
  if (agentId) return `Agent ${agentId}`;
  return 'Worker task';
}

export function isLocalSandboxFilePath(value: string): boolean {
  if (!value) return false;
  if (/^(https?:|data:|blob:)/i.test(value)) return false;
  return value.startsWith('/');
}

// ─── Markdown detection (web lib/markdown-detect.ts) ─────────────────────────

/** Conservative: only unambiguous markdown syntax counts. */
export { looksLikeMarkdown } from '@kortix/shared/tool-output';

// ─── Frontmatter (web components/markdown/markdown-frontmatter.tsx) ──────────

export type FrontmatterValue = string | Record<string, string>;

export interface ParsedMarkdown {
  frontmatter: Record<string, FrontmatterValue> | null;
  body: string;
}

/** Extract a leading `---\n…\n---` block: flat keys plus one nesting level. */
export function parseFrontmatter(content: string): ParsedMarkdown {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { frontmatter: null, body: content };

  const yaml = match[1];
  const body = match[2];
  const result: Record<string, FrontmatterValue> = {};
  let currentParent: string | null = null;

  for (const rawLine of yaml.split(/\r?\n/)) {
    // `trimEnd` drops what `/\s+$/` did; the regex retried a whitespace run
    // inside the line from every position in it (quadratic on V8).
    const line = rawLine.trimEnd();
    if (!line.trim() || line.trim().startsWith('#')) continue;

    const nested = line.match(/^\s+(?:"([^"]+)"|'([^']+)'|([\w.*/-]+))\s*:\s*(.*)$/);
    if (nested && currentParent && typeof result[currentParent] === 'object') {
      const key = nested[1] ?? nested[2] ?? nested[3];
      (result[currentParent] as Record<string, string>)[key] = nested[4].trim();
      continue;
    }

    const top = line.match(/^([\w.-]+)\s*:\s*(.*)$/);
    if (top) {
      const [, key, value] = top;
      const trimmed = value.trim();
      if (!trimmed) {
        result[key] = {};
        currentParent = key;
      } else {
        result[key] = trimmed;
        currentParent = null;
      }
    }
  }

  for (const k of Object.keys(result)) {
    if (typeof result[k] === 'object' && Object.keys(result[k] as object).length === 0) {
      result[k] = '';
    }
  }

  return { frontmatter: result, body };
}

// ─── Language from a path ────────────────────────────────────────────────────

const FILENAME_LANGUAGES: Record<string, string> = {
  dockerfile: 'dockerfile',
  makefile: 'makefile',
  '.env': 'dotenv',
};

/**
 * The highlighter language for a file path: the extension through
 * `normalizeLanguage` (`ts` → `typescript`), a few well-known file names, and
 * `text` for anything the app bundles no grammar for.
 */
export function languageFromPath(path: string | undefined): string {
  if (!path) return 'text';
  const name = (path.split('/').pop() ?? path).toLowerCase();
  const known = FILENAME_LANGUAGES[name];
  if (known) return known;
  const dot = name.lastIndexOf('.');
  if (dot < 0) return 'text';
  const lang = normalizeLanguage(name.slice(dot + 1));
  return isHighlightLang(lang) ? lang : 'text';
}
