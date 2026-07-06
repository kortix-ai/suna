/**
 * Per-tool view models — the "what should a product UI actually show for
 * this tool call" layer on top of `ToolView`.
 *
 * `ToolView` (classify.ts) normalizes the wire's pending/running/completed/
 * error state machine and now detects embedded (completed-but-actually-
 * failed) failures — but it still leaves `input`/`output` as loosely-typed
 * bags. Rendering a web search, a shell command, and a file edit all the
 * same way (a JSON blob in a `<pre>`) is what produced the original bug:
 * a real failure LOOKED like a success because nothing gave it special
 * shape. `toolViewModel` maps a `ToolView` to a small discriminated union
 * with one variant per tool family a product UI is expected to render
 * specially, plus a `generic` fallback for everything else.
 *
 * Field shapes below are grounded in the real wire data, not guessed:
 *  - web_search / image_search: `.kortix/opencode/tools/web_search.ts` +
 *    `image_search.ts` (this repo) — success shape
 *    `{query, success, answer, results:[{title,url,snippet,...}], images}`,
 *    failure shape `{query, success:false, error}`; image_search's images
 *    carry `{url,title,source,description}` instead of `results`.
 *  - shell (bash): `apps/web/src/features/session/tool-renderers.tsx`
 *    (`partOutput`) and `apps/mobile/components/session/SessionTurn.tsx`
 *    (`ShellExpandedContent`) — `input.command`, raw text output with
 *    `<bash_metadata>`/`<exit_code>`/`<system_info>`/`<stderr_note>` tags to
 *    strip.
 *  - file read/write/edit: `apps/mobile/.../SessionTurn.tsx`
 *    (`WriteEditExpandedContent`) — `input.filePath`, `input.oldString`/
 *    `input.newString` for edit, `input.content` for write.
 *  - search (grep/glob): `apps/web/.../tool-renderers.tsx`
 *    (`parseFilePaths`, `parseGrepOutput`) — glob output is a newline list of
 *    paths; grep output is `Found N matches\n\n/path:\nLine N: content...`.
 *  - task: `toolInfo`'s `task` entry + `getAgentCardLabel` (index.ts) —
 *    `input.description`/`input.subagent_type`/`input.prompt`.
 *  - todo (todowrite): `apps/mobile/.../SessionTurn.tsx`
 *    (`TodosExpandedContent`) — `input.todos: {content,status,priority?}[]`.
 *  - question: `apps/web/.../tool-renderers.tsx` (`QuestionTool`) —
 *    `input.questions: {question,header?,options:{label,description?}[]}[]`.
 *
 * `permission` isn't included: it's a request keyed by `{messageID,callID}`
 * pointing AT a tool call (see `RequestWithToolLike` in types.ts), not a
 * tool call itself — there's no tool named `permission` on the wire.
 */

import { normalizeToolName } from './tool-registry';
import type { ToolView } from './classify';

// ============================================================================
// Shared shapes
// ============================================================================

export interface WebSearchResultItem {
  title: string;
  url: string;
  snippet?: string;
}

export interface SearchMatch {
  path: string;
  line?: number;
  content?: string;
}

export type DiffLineType = 'added' | 'removed' | 'unchanged';

export interface DiffLine {
  type: DiffLineType;
  text: string;
}

export interface TodoItem {
  content: string;
  status: string;
  priority?: string;
}

export interface QuestionOption {
  label: string;
  description?: string;
}

export interface QuestionItem {
  question: string;
  header?: string;
  options: QuestionOption[];
}

// ============================================================================
// ToolViewModel — the discriminated union
// ============================================================================

export type ToolViewModel =
  | {
      kind: 'web-search';
      query: string;
      results?: WebSearchResultItem[];
      answer?: string;
      error?: string;
    }
  | { kind: 'shell'; command: string; stdout?: string; exitCode?: number }
  | { kind: 'file-read'; path: string; preview?: string }
  | { kind: 'file-write'; path: string; preview?: string }
  | { kind: 'file-edit'; path: string; diff?: DiffLine[] }
  | { kind: 'search'; pattern: string; matches?: SearchMatch[] }
  | { kind: 'task'; description: string; agent?: string }
  | { kind: 'todo'; items: TodoItem[] }
  | { kind: 'question'; questions: QuestionItem[]; answers?: string[][] }
  | { kind: 'generic'; label: string; inputPretty?: string; outputPretty?: string };

const PRETTY_CAP = 4000;

function capText(text: string, max = PRETTY_CAP): string {
  return text.length > max ? `${text.slice(0, max)}\n…` : text;
}

function prettyJson(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  try {
    return capText(JSON.stringify(value, null, 2));
  } catch {
    return undefined;
  }
}

/** First non-empty string among candidates — tool inputs use inconsistent
 *  key names across tool families (`filePath` vs `file_path` vs `path`). */
function firstString(...candidates: unknown[]): string | undefined {
  for (const c of candidates) {
    if (typeof c === 'string' && c.length > 0) return c;
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

// ============================================================================
// web-search / image-search
// ============================================================================

function webSearchViewModel(tool: ToolView): Extract<ToolViewModel, { kind: 'web-search' }> {
  const inputQuery = firstString(tool.input?.query) ?? '';

  if (tool.status === 'error') {
    return { kind: 'web-search', query: inputQuery, error: tool.error ?? 'Search failed' };
  }

  const obj = asRecord(tool.outputParsed);
  if (!obj) return { kind: 'web-search', query: inputQuery };

  const rawItems = Array.isArray(obj.results)
    ? (obj.results as unknown[])
    : Array.isArray(obj.images)
      ? (obj.images as unknown[])
      : [];

  const results: WebSearchResultItem[] = rawItems.slice(0, 50).map((raw) => {
    const r = asRecord(raw) ?? {};
    return {
      title: firstString(r.title) ?? '',
      url: firstString(r.url, r.link) ?? '',
      snippet: firstString(r.snippet, r.description, r.source),
    };
  });

  return {
    kind: 'web-search',
    query: firstString(obj.query) ?? inputQuery,
    results: results.length > 0 ? results : undefined,
    answer: firstString(obj.answer),
  };
}

// ============================================================================
// shell (bash)
// ============================================================================

const EXIT_CODE_RE = /<exit_code>\s*(-?\d+)\s*<\/exit_code>/;

// Linear (indexOf-based) tag strippers — the regex forms
// (`/<bash_metadata>[\s\S]*?<\/bash_metadata>/g` and a lazy tail matcher)
// backtrack polynomially on adversarial output (CodeQL js/polynomial-redos),
// and shell output is arbitrary user/tool-controlled text.

/** Remove every `<open>…</close>` block; an unterminated block is left as-is
 *  (matching the old lazy-regex behavior, which required the closing tag). */
function stripTagBlocks(s: string, open: string, close: string): string {
  let out = '';
  let i = 0;
  for (;;) {
    const start = s.indexOf(open, i);
    if (start === -1) return out + s.slice(i);
    const end = s.indexOf(close, start + open.length);
    if (end === -1) return out + s.slice(i);
    out += s.slice(i, start);
    i = end + close.length;
  }
}

const INTERNAL_TAG_MARKERS = [
  '<system_info>',
  '</system_info>',
  '<exit_code>',
  '</exit_code>',
  '<stderr_note>',
  '</stderr_note>',
];

/** Cut the trailing internal-protocol tag block: everything from the FIRST
 *  internal tag marker onward. These tags are appended by the bash tool AFTER
 *  the real output, so first-marker-to-end is the whole machine tail. */
function stripInternalTagTail(s: string): string {
  let cut = -1;
  for (const marker of INTERNAL_TAG_MARKERS) {
    const idx = s.indexOf(marker);
    if (idx !== -1 && (cut === -1 || idx < cut)) cut = idx;
  }
  return cut === -1 ? s : s.slice(0, cut);
}

// Minimal local ANSI stripper mirroring `stripAnsi` in turns/index.ts —
// duplicated (rather than imported) to avoid a circular import between this
// module and the barrel file that re-exports it.
const ANSI_RE =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching terminal escape sequences requires literal ESC/BEL control characters
  /\x1B\[[\d;]*[A-Za-z]|\x1B\][^\x07]{0,512}\x07|\x1B[()#][A-Z0-9]|\x1B\[?[\d;]*[hl]|\x1B[>=<]|\x1B\[[?]?\d*[A-Z]|\x1B\[\d*[JKHG]|\x1B\[\d*;\d*[Hf]|\x1b\[[0-9;]*m/g;

function stripAnsiLocal(str: string): string {
  return str.replace(ANSI_RE, '');
}

function shellViewModel(tool: ToolView): Extract<ToolViewModel, { kind: 'shell' }> {
  const command = firstString(tool.input?.command) ?? '';
  const raw = tool.output ?? '';
  const exitMatch = raw.match(EXIT_CODE_RE);
  const exitCode = exitMatch ? Number(exitMatch[1]) : undefined;
  const cleaned = stripAnsiLocal(
    stripInternalTagTail(stripTagBlocks(raw, '<bash_metadata>', '</bash_metadata>')),
  ).trim();
  const stdout = cleaned || (tool.status === 'error' ? tool.error : undefined);
  return { kind: 'shell', command, stdout: stdout || undefined, exitCode };
}

// ============================================================================
// file read / write / edit
// ============================================================================

function filePath(tool: ToolView): string {
  return firstString(tool.input?.filePath, tool.input?.file_path, tool.input?.path) ?? '';
}

function fileReadViewModel(tool: ToolView): Extract<ToolViewModel, { kind: 'file-read' }> {
  const preview =
    tool.status === 'error' ? tool.error : (tool.output && capText(tool.output)) || undefined;
  return { kind: 'file-read', path: filePath(tool), preview };
}

function fileWriteViewModel(tool: ToolView): Extract<ToolViewModel, { kind: 'file-write' }> {
  const content = firstString(tool.input?.content);
  const preview =
    tool.status === 'error'
      ? tool.error
      : capText(content ?? tool.output ?? '') || undefined;
  return { kind: 'file-write', path: filePath(tool), preview };
}

/** Cap total input size before diffing — the naive O(n) prefix/suffix trim
 *  below is cheap, but there's no reason to diff a multi-hundred-KB blob for
 *  a chat UI card. */
const MAX_DIFF_INPUT_LENGTH = 256 * 1024;

/**
 * Line diff between an edit tool's `oldString`/`newString`. Not a general
 * LCS diff — `edit`/`morph_edit` operate on one contiguous replaced block,
 * so trimming the common prefix/suffix and marking the differing middle as
 * removed/added is both correct for that shape and O(n) instead of O(n²).
 */
function computeLineDiff(oldStr: string, newStr: string): DiffLine[] | undefined {
  if (oldStr.length + newStr.length > MAX_DIFF_INPUT_LENGTH) return undefined;
  const oldLines = oldStr.split('\n');
  const newLines = newStr.split('\n');

  let start = 0;
  while (
    start < oldLines.length &&
    start < newLines.length &&
    oldLines[start] === newLines[start]
  ) {
    start++;
  }

  let oldEnd = oldLines.length;
  let newEnd = newLines.length;
  while (oldEnd > start && newEnd > start && oldLines[oldEnd - 1] === newLines[newEnd - 1]) {
    oldEnd--;
    newEnd--;
  }

  const lines: DiffLine[] = [];
  for (let i = 0; i < start; i++) lines.push({ type: 'unchanged', text: oldLines[i] });
  for (let i = start; i < oldEnd; i++) lines.push({ type: 'removed', text: oldLines[i] });
  for (let i = start; i < newEnd; i++) lines.push({ type: 'added', text: newLines[i] });
  for (let i = oldEnd; i < oldLines.length; i++) lines.push({ type: 'unchanged', text: oldLines[i] });
  return lines;
}

function fileEditViewModel(tool: ToolView): Extract<ToolViewModel, { kind: 'file-edit' }> {
  const oldString = firstString(tool.input?.oldString);
  const newString = firstString(tool.input?.newString);
  const diff =
    oldString !== undefined && newString !== undefined
      ? computeLineDiff(oldString, newString)
      : undefined;
  return { kind: 'file-edit', path: filePath(tool), diff };
}

// ============================================================================
// search (grep / glob)
// ============================================================================

const GREP_HEADER_RE = /^Found\s+(\d+)\s+match/i;
const GREP_FILE_HEADER_RE = /^(\/[^:]+?):\s*/;
// Header-only matcher — content between consecutive headers is sliced out
// positionally below. The previous single-regex form captured content with a
// lazy `[\s\S]*?` + lookahead-alternation, which backtracks polynomially on
// adversarial output like repeated "Line\t0:" (CodeQL js/polynomial-redos).
const GREP_LINE_HEADER_RE = /Line\s+(\d+):/g;

function parseGrepMatches(output: string): SearchMatch[] {
  const text = output.trim();
  const headerMatch = text.match(GREP_HEADER_RE);
  const body = headerMatch ? text.slice(headerMatch[0].length).trim() : text;
  if (!body) return [];

  const matches: SearchMatch[] = [];
  for (const block of body.split(/\n\n+/)) {
    const trimmed = block.trim();
    if (!trimmed) continue;
    const fileMatch = trimmed.match(GREP_FILE_HEADER_RE);
    if (!fileMatch) continue;
    const path = fileMatch[1];
    const rest = trimmed.slice(fileMatch[0].length);
    // Scan headers linearly, then slice each entry's content as the span up
    // to the next header (or end) — no backtracking-prone content capture.
    const headers: { line: number; contentStart: number; headerStart: number }[] = [];
    let m: RegExpExecArray | null;
    GREP_LINE_HEADER_RE.lastIndex = 0;
    while ((m = GREP_LINE_HEADER_RE.exec(rest)) !== null) {
      headers.push({ line: Number(m[1]), contentStart: m.index + m[0].length, headerStart: m.index });
    }
    for (let i = 0; i < headers.length; i++) {
      const end = i + 1 < headers.length ? headers[i + 1].headerStart : rest.length;
      const content = rest.slice(headers[i].contentStart, end).trim();
      matches.push({
        path,
        line: headers[i].line,
        content: content.endsWith(';') ? content.slice(0, -1) : content,
      });
    }
  }
  return matches;
}

function parseGlobMatches(output: string): SearchMatch[] {
  return output
    .trim()
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('/') || l.startsWith('./') || l.startsWith('~'))
    .map((path) => ({ path }));
}

function searchViewModel(tool: ToolView): Extract<ToolViewModel, { kind: 'search' }> {
  const pattern = firstString(tool.input?.pattern, tool.input?.query) ?? '';
  if (tool.status === 'error' || !tool.output) return { kind: 'search', pattern };
  const matches = GREP_HEADER_RE.test(tool.output.trim())
    ? parseGrepMatches(tool.output)
    : parseGlobMatches(tool.output);
  return { kind: 'search', pattern, matches: matches.length > 0 ? matches.slice(0, 200) : undefined };
}

// ============================================================================
// task
// ============================================================================

function taskViewModel(tool: ToolView): Extract<ToolViewModel, { kind: 'task' }> {
  const description =
    firstString(tool.input?.description, tool.input?.title, tool.input?.prompt) ?? tool.title;
  const agent = firstString(tool.input?.subagent_type, tool.input?.agent);
  return { kind: 'task', description, agent };
}

// ============================================================================
// todo (todowrite)
// ============================================================================

function normalizeTodo(raw: unknown): TodoItem {
  const t = asRecord(raw) ?? {};
  return {
    content: firstString(t.content) ?? '',
    status: firstString(t.status) ?? 'pending',
    priority: firstString(t.priority),
  };
}

function todoViewModel(tool: ToolView): Extract<ToolViewModel, { kind: 'todo' }> {
  const inputTodos = tool.input?.todos;
  if (Array.isArray(inputTodos)) return { kind: 'todo', items: inputTodos.map(normalizeTodo) };

  if (Array.isArray(tool.outputParsed)) {
    return { kind: 'todo', items: tool.outputParsed.map(normalizeTodo) };
  }
  const outObj = asRecord(tool.outputParsed);
  if (outObj && Array.isArray(outObj.todos)) {
    return { kind: 'todo', items: (outObj.todos as unknown[]).map(normalizeTodo) };
  }
  return { kind: 'todo', items: [] };
}

// ============================================================================
// question
// ============================================================================

function questionViewModel(tool: ToolView): Extract<ToolViewModel, { kind: 'question' }> {
  const rawQuestions = Array.isArray(tool.input?.questions) ? tool.input.questions : [];
  const questions: QuestionItem[] = rawQuestions.map((rawQuestion) => {
    const q = asRecord(rawQuestion) ?? {};
    const rawOptions = Array.isArray(q.options) ? q.options : [];
    const options: QuestionOption[] = rawOptions.flatMap((rawOption) => {
      const o = asRecord(rawOption);
      const label = o && firstString(o.label);
      return label ? [{ label, description: o ? firstString(o.description) : undefined }] : [];
    });
    return { question: firstString(q.question) ?? '', header: firstString(q.header), options };
  });
  return { kind: 'question', questions };
}

// ============================================================================
// generic fallback
// ============================================================================

function genericViewModel(tool: ToolView): Extract<ToolViewModel, { kind: 'generic' }> {
  const hasInput = tool.input && Object.keys(tool.input).length > 0;
  const inputPretty = hasInput ? prettyJson(tool.input) : undefined;

  let outputPretty: string | undefined;
  if (tool.outputParsed !== undefined) {
    outputPretty =
      typeof tool.outputParsed === 'string' ? capText(tool.outputParsed) : prettyJson(tool.outputParsed);
  } else if (tool.outputText !== undefined) {
    outputPretty = capText(tool.outputText);
  } else {
    outputPretty = tool.error;
  }

  return { kind: 'generic', label: tool.title, inputPretty, outputPretty };
}

// ============================================================================
// toolViewModel — the dispatcher
// ============================================================================

/**
 * Map a normalized `ToolView` to its typed `ToolViewModel`. Known tool
 * families (web/image search, shell, file read/write/edit, grep/glob,
 * task, todowrite, question) get a shape a product UI can render specially;
 * anything else (webfetch, scrape_webpage, image_gen, presentation_gen,
 * session_, agent_, project_, trigger_ prefixed plugin tools, pty_*, …) falls back
 * to `generic`, which is always safe to render (pretty-printed input/output,
 * capped).
 */
export function toolViewModel(tool: ToolView): ToolViewModel {
  const name = normalizeToolName(tool.name);
  switch (name) {
    case 'web_search':
    case 'websearch':
    case 'image_search':
      return webSearchViewModel(tool);
    case 'bash':
      return shellViewModel(tool);
    case 'read':
      return fileReadViewModel(tool);
    case 'write':
      return fileWriteViewModel(tool);
    case 'edit':
    case 'morph_edit':
      return fileEditViewModel(tool);
    case 'grep':
    case 'glob':
      return searchViewModel(tool);
    case 'task':
      return taskViewModel(tool);
    case 'todowrite':
      return todoViewModel(tool);
    case 'question':
    case 'ask':
      return questionViewModel(tool);
    default:
      return genericViewModel(tool);
  }
}
