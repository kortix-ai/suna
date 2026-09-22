/**
 * Tool-part accessors — the pure helpers every tool renderer starts with.
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

import type { ToolPart } from '@kortix/sdk';
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

function isEmptyObject(value: Record<string, unknown>): boolean {
  for (const key in value) {
    if (Object.prototype.hasOwnProperty.call(value, key)) return false;
  }
  return true;
}

type StateWithInput = { status: string; input?: Record<string, unknown>; raw?: string };

const STREAMING_INPUT_CACHE = new WeakMap<
  ToolPart,
  { state: ToolPart['state']; raw: string; input: Record<string, unknown> }
>();

/** A call's arguments, including the half-arrived ones — memoised per part. */
export function partStreamingInput(part: ToolPart): Record<string, unknown> {
  const state = part.state as unknown as StateWithInput;
  const input = state.input;
  if (input && !isEmptyObject(input)) return input;

  if (state.status === 'pending' || state.status === 'running') {
    const raw = state.raw ?? '';
    if (raw) {
      const cached = STREAMING_INPUT_CACHE.get(part);
      if (cached && cached.state === part.state && cached.raw === raw) return cached.input;
      const parsed = parsePartialJSON(raw);
      STREAMING_INPUT_CACHE.set(part, { state: part.state, raw, input: parsed });
      return parsed;
    }
  }
  return input ?? EMPTY_RECORD;
}

export function partInput(part: ToolPart): Record<string, unknown> {
  return partStreamingInput(part);
}

export function partMetadata(part: ToolPart): Record<string, unknown> {
  const state = part.state as unknown as { status: string; metadata?: Record<string, unknown> };
  if (state.status === 'completed' || state.status === 'running' || state.status === 'error') {
    return state.metadata ?? EMPTY_RECORD;
  }
  return EMPTY_RECORD;
}

const OUTPUT_CACHE = new WeakMap<ToolPart, { state: ToolPart['state']; output: string }>();

/** A completed tool's output, stripped of transport noise — memoised per part. */
export function partOutput(part: ToolPart): string {
  const state = part.state as unknown as { status: string; output?: string };
  if (state.status !== 'completed') return '';

  const cached = OUTPUT_CACHE.get(part);
  if (cached && cached.state === part.state) return cached.output;

  const output = (state.output ?? '')
    .replace(/<bash_metadata>[\s\S]*?<\/bash_metadata>/g, '')
    .replace(/<\/?(?:system_info|exit_code|stderr_note)>[\s\S]*?(?:<\/\w+>)?$/g, '')
    .trim();

  OUTPUT_CACHE.set(part, { state: part.state, output });
  return output;
}

export function partStatus(part: ToolPart): string {
  return part.state.status;
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

const MD_SIGNALS: RegExp[] = [
  /^#{1,6}\s+\S/m,
  /```/,
  /\*\*[^*\n]+\*\*/,
  /(^|[^`])`[^`\n]+`([^`]|$)/,
  /\[[^\]\n]+\]\([^)\n]+\)/,
  /^\s*\d+\.\s+\S/m,
];

/** Conservative: only unambiguous markdown syntax counts. */
export function looksLikeMarkdown(text: string): boolean {
  return MD_SIGNALS.some((re) => re.test(text));
}

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
    const line = rawLine.replace(/\s+$/, '');
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
