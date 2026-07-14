/**
 * What the agent MADE (Outputs) versus what it LOOKED AT (Context).
 *
 * Both are derived from the same ToolPart[] the Progress list reads — Easy mode
 * adds no data source, it only re-partitions what is already there.
 *
 * Classification is delegated to narration.ts wherever it already owns the
 * answer (`familyForTool` for which tools write/read/browse the web,
 * `createArtifactKind` for which image_gen/presentation_gen actions leave
 * behind a real artifact to open versus a pure read/delete/listing) — this
 * file must never re-derive that logic with its own second set of tool-name
 * tables, or the two cards could disagree with what Progress just narrated
 * for the same call.
 */

import type { ToolPart } from '@/ui';
import { parseImageOutput } from '../../image-output-path';
import type { PatchFileLite } from '../../tool/shared/patch-helpers';
import { parsePresentationOutput } from '../../tool/shared/presentation-helpers';
import { looksLikeHtml, parseWebSearchOutput, wsDomain } from '../../tool/shared/web-helpers';
import { getToolPrimaryArg, normalizeName } from '../../tool/tool-meta';
import { extractReadableHtml } from '../../tool/tool-renderers-sanitization';
import { createArtifactKind, familyForTool, humanizeToolName } from './narration';

interface OutputItemBase {
  callID: string;
  name: string;
}

type ArtifactOutputItem = OutputItemBase & {
  kind: 'file' | 'image' | 'video' | 'presentation';
  path?: string;
  url?: never;
};

type AppOutputItem = OutputItemBase & {
  kind: 'app';
  path?: never;
  /**
   * The URL the thing is running at. When a user asks for a web page
   * or a React app, the deliverable is not a file on disk — it's a server on a
   * port. Outputs has to be able to hand them the *running thing*, or the one
   * output they actually wanted is the one they can't reach.
   */
  url: string;
};

export type OutputItem = ArtifactOutputItem | AppOutputItem;

export interface ContextItem {
  callID: string;
  label: string;
  kind: 'file' | 'web' | 'tool';
  /** The real URL a `web` item points at — never rendered as the label
   * itself, only as a title attribute / link target for the row. */
  url?: string;
  /** Every call behind a `tool` item, so the UI can show what the tool
   * actually did (its real tool views) when the user opens the chip. */
  parts?: ToolPart[];
}

function filePathOf(part: ToolPart): string | undefined {
  const input = (part.state?.input ?? {}) as Record<string, unknown>;
  const p = input.filePath ?? input.file_path ?? input.path;
  return typeof p === 'string' && p ? p : undefined;
}

/** Last path segment, tolerant of both `/` and `\` separators. */
function basename(p: string): string {
  const cleaned = p.replace(/\\/g, '/').replace(/\/+$/, '');
  const idx = cleaned.lastIndexOf('/');
  return idx >= 0 ? cleaned.slice(idx + 1) : cleaned;
}

function truncate(s: string, max = 60): string {
  const trimmed = s.replace(/\s+/g, ' ').trim();
  return trimmed.length > max ? trimmed.slice(0, max - 1) + '…' : trimmed;
}

/** `part.state.output`, without the bash-only tag stripping `partOutput`
 * (tool/shared/infrastructure.tsx) does — image_gen/presentation_gen output
 * is a flat JSON payload, never bash's tagged output. */
function rawOutputOf(part: ToolPart): string {
  const state = part.state as { status?: string; output?: string } | undefined;
  return state?.status === 'completed' && typeof state.output === 'string' ? state.output : '';
}

/** `part.state.metadata`, mirroring `partMetadata` (tool/shared/infrastructure.tsx)
 * without importing that client-component module into this plain data file. */
function rawMetadataOf(part: ToolPart): Record<string, unknown> {
  const state = part.state as { status?: string; metadata?: unknown } | undefined;
  const status = state?.status;
  if (status === 'completed' || status === 'running' || status === 'error') {
    return (state?.metadata as Record<string, unknown>) ?? {};
  }
  return {};
}

/**
 * apply_patch's INPUT is an opaque patch blob — no filename lives there.
 * The per-file paths only exist in its OUTPUT metadata (`state.metadata.files`),
 * the exact shape ApplyPatchTool itself renders from (see PatchFileLite). One
 * call can touch several files, so this returns one OutputItem per file
 * actually changed — never a single item named after the tool. Deletions are
 * skipped: there is nothing left for the user to open.
 */
function applyPatchOutputs(part: ToolPart): OutputItem[] {
  const raw = rawMetadataOf(part).files;
  if (!Array.isArray(raw)) return [];

  const items: OutputItem[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const file = entry as PatchFileLite;
    if (file.type === 'delete') continue;
    const relativePath = typeof file.relativePath === 'string' ? file.relativePath : '';
    const filePath = typeof file.filePath === 'string' ? file.filePath : '';
    const path = relativePath || filePath;
    if (!path) continue;
    const name = basename(path);
    if (!name) continue;
    items.push({ callID: part.callID, name, path: filePath || path, kind: 'file' });
  }
  return items;
}

/**
 * The real artifact name (and path, if known) for image_gen / presentation_gen
 * calls — never `humanizeToolName(part.tool)` ("Image Gen"/"Presentation Gen").
 * Both components resolve their real name the same way: parse the tool's
 * OUTPUT payload (parseImageOutput / parsePresentationOutput), falling back to
 * the request's own input fields, and only then to a truthful generic noun.
 */
function createArtifactName(part: ToolPart): { name: string; path?: string } {
  const t = normalizeName(part.tool);
  const input = (part.state?.input ?? {}) as Record<string, unknown>;

  if (t === 'image_gen') {
    const { imagePath } = parseImageOutput(rawOutputOf(part));
    if (imagePath) {
      const name = basename(imagePath);
      if (name) return { name, path: imagePath };
    }
    const prompt = typeof input.prompt === 'string' ? input.prompt : '';
    return { name: prompt ? truncate(prompt) : 'Image' };
  }

  if (t === 'presentation_gen') {
    const parsed = parsePresentationOutput(rawOutputOf(part));
    const presentationName =
      parsed?.presentation_name ||
      (typeof input.presentation_name === 'string' ? input.presentation_name : '');
    const slideTitle =
      parsed?.slide_title || (typeof input.slide_title === 'string' ? input.slide_title : '');
    const path = parsed?.presentation_path;
    if (presentationName && slideTitle) return { name: `${presentationName}: ${slideTitle}`, path };
    if (presentationName) return { name: presentationName, path };
    if (slideTitle) return { name: slideTitle, path };
    return { name: 'Presentation', path };
  }

  // video_gen / show / show_user — unchanged behavior.
  return { name: getToolPrimaryArg(part) || humanizeToolName(part.tool) };
}

/** The part's raw `state.status`, however it's currently framed. */
function statusOf(part: ToolPart): string | undefined {
  return (part.state as { status?: string } | undefined)?.status;
}

export function deriveOutputs(parts: ToolPart[]): OutputItem[] {
  const out: OutputItem[] = [];
  const seen = new Set<string>();

  for (const part of parts) {
    // A call that errored produced nothing — surfacing it here would
    // advertise a file/image/presentation that doesn't exist, and clicking
    // it would fire `requestFileOpen` on a path that was never written. A
    // call still 'running'/'pending' hasn't produced anything YET either —
    // an artifact only exists once the call actually completes.
    const status = statusOf(part);
    if (status === 'error' || status === 'running' || status === 'pending') continue;

    const family = familyForTool(part.tool);
    if (family === 'hidden') continue;

    if (family === 'edit') {
      // apply_patch has no name in its input at all — its per-file paths
      // live only in output metadata, and one call can produce several files.
      if (normalizeName(part.tool) === 'apply_patch') {
        for (const item of applyPatchOutputs(part)) {
          const key = item.path ?? item.name;
          if (seen.has(key)) continue;
          seen.add(key);
          out.push(item);
        }
        continue;
      }

      // write / edit / morph_edit — a file the agent wrote.
      const path = filePathOf(part);
      const name = getToolPrimaryArg(part);
      if (!name) continue;
      const key = path ?? name;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ callID: part.callID, name, path, kind: 'file' });
      continue;
    }

    if (family === 'create') {
      // `show` is the agent HANDING OVER what it produced — a running site, a
      // spreadsheet, a deck. `createArtifactKind` returns null for it, rightly:
      // showing a file isn't *making* one, and narration must never claim it
      // did. But Outputs asks a different question — "is there something here I
      // can open?" — and for a shown artifact the answer is plainly yes.
      //
      // One `show` can hand over SEVERAL things at once (the chat renders them
      // as a carousel), so this yields a list, not a single item. That is the
      // whole reason a run that produced a CSV, an XLSX, a DOCX, a PPTX and a
      // PDF in one show showed *none* of them: the payload had no top-level
      // path, only `items[]`.
      const shown = showOutputsOf(part);
      if (shown.length > 0) {
        for (const item of shown) {
          const key = item.url ?? item.path ?? item.name;
          if (seen.has(key)) continue;
          seen.add(key);
          out.push(item);
        }
        continue;
      }

      // image_gen / video_gen / presentation_gen — ask narration.ts's own action
      // tables whether this specific call made anything, rather than assuming
      // every call to these tool names did.
      const kind = createArtifactKind(part);
      if (!kind) continue;
      const { name, path } = createArtifactName(part);
      out.push({ callID: part.callID, name, path, kind });
    }
  }

  return out;
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|avif|heic|bmp)$/i;
const VIDEO_EXT = /\.(mp4|mov|webm|avi|mkv)$/i;
const DECK_EXT = /\.(pptx?|key)$/i;

/** One thing a `show` can hand over — the shape of both its top-level input and
 *  each entry in its `items[]`. */
interface ShowPayload {
  path?: unknown;
  url?: unknown;
  title?: unknown;
}

/** A single shown thing → the row it becomes, or null if there's nothing to open. */
function showPayloadToOutput(payload: ShowPayload, callID: string): OutputItem | null {
  const url = typeof payload.url === 'string' ? payload.url.trim() : '';
  if (url && /^https?:\/\//i.test(url)) return appOutput(url, payload.title, callID);

  const path = typeof payload.path === 'string' ? payload.path.trim() : '';
  // No path and no URL: a string, an inline chunk of text, an error message.
  // Real, but not a thing you can open — and a row you can't click is worse
  // than no row.
  if (!path) return null;

  const name = basename(path) || path;
  // The kind drives the row's glyph AND which renderer opens: a sheet must open
  // as a grid, not as a wall of text.
  const kind: OutputItem['kind'] = IMAGE_EXT.test(name)
    ? 'image'
    : VIDEO_EXT.test(name)
      ? 'video'
      : DECK_EXT.test(name)
        ? 'presentation'
        : 'file';

  return { callID, name, path, kind };
}

/**
 * Everything a single `show` call hands over.
 *
 * `show` is how the agent says "here is what you asked for", and it's the only
 * signal we get for files it produced with a *script* rather than by writing
 * them directly — a `.pdf` from pandoc, an `.xlsx` from python, a `.csv` from a
 * query. Those are never `write` calls, so without this they sit on disk and
 * appear nowhere.
 *
 * Crucially, ONE show can carry MANY things: the agent generates five files and
 * shows them together (the chat renders that as a carousel). The payload then
 * has no top-level `path` at all — only `items[]` — which is exactly why a run
 * that produced a CSV, XLSX, DOCX, PPTX and PDF surfaced none of them.
 */
function showOutputsOf(part: ToolPart): OutputItem[] {
  const tool = normalizeName(part.tool);
  if (tool !== 'show' && tool !== 'show_user') return [];

  const input = (part.state?.input ?? {}) as Record<string, unknown> & ShowPayload;

  const items = parseShowItems(input.items);
  if (items.length > 0) {
    return items
      .map((item) => showPayloadToOutput(item ?? {}, part.callID))
      .filter((item): item is OutputItem => item !== null);
  }

  const single = showPayloadToOutput(input, part.callID);
  return single ? [single] : [];
}

/**
 * `items` reaches us as EITHER an array or a JSON string — the model serializes
 * it, and nothing downstream normalizes that before it lands in `state.input`.
 * `ShowTool` handles both (`typeof raw === 'string' ? JSON.parse(raw) : raw`),
 * which is why the chat rendered all five files perfectly while Outputs showed
 * none of them: an `Array.isArray` check sees a string and quietly moves on.
 */
function parseShowItems(raw: unknown): ShowPayload[] {
  if (Array.isArray(raw)) return raw as ShowPayload[];
  if (typeof raw !== 'string') return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ShowPayload[]) : [];
  } catch {
    // Half-streamed or malformed JSON. Show nothing rather than throw and take
    // the whole panel down with it.
    return [];
  }
}

/**
 * A running app, if this call is handing one over.
 *
 * Named for the user's word, not the machine's: they asked for "a landing page"
 * or "a dashboard", and what they get back is a thing they can open. The port
 * number is the fallback name, never the first choice — `localhost:3000` means
 * nothing to someone who has never run a server.
 */
function appOutput(url: string, rawTitle: unknown, callID: string): AppOutputItem {
  const title = typeof rawTitle === 'string' ? rawTitle.trim() : '';

  let fallback = url;
  try {
    const parsed = new URL(url);
    fallback = parsed.port ? `${parsed.hostname}:${parsed.port}` : parsed.hostname;
  } catch {
    // A URL we can't parse still opens fine — just show it as-is.
  }

  return { callID, name: title || fallback, kind: 'app', url };
}

/**
 * Collapse protocol/`www.`/trailing-slash differences so the same page
 * fetched two different ways (http vs https, with vs without `www.`, with
 * vs without a trailing slash) normalizes to one dedup key. Never shown to
 * the user — `web[].label` is always a title or a domain (see `webSourceOf`).
 */
function normalizeUrl(raw: string): string {
  return raw
    .trim()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
    .replace(/^www\./i, '')
    .replace(/\/+$/, '')
    .toLowerCase();
}

/** A page title extracted from a `web_fetch`/`webfetch` call's own HTML
 * output, reusing the exact same parsing WebFetchTool itself uses — never a
 * second, divergent HTML-sniffing implementation. `undefined` for non-HTML
 * output (plain text/markdown fetches carry no separate title). */
function titleFromFetchOutput(part: ToolPart): string | undefined {
  const output = rawOutputOf(part);
  const input = (part.state?.input ?? {}) as Record<string, unknown>;
  const format = typeof input.format === 'string' ? input.format : '';
  const isHtml = format === 'html' || (!format && looksLikeHtml(output));
  if (!isHtml || !output) return undefined;
  return extractReadableHtml(output).title || undefined;
}

/**
 * The one real-world page a `web`-family call is "about", if any — the
 * identity `deriveContext` dedups on and the truthful label it shows.
 *
 * - `web_fetch`/`scrape_webpage`-style calls target a URL directly (`input.url`).
 * - `web_search`-style calls have no URL of their own, but their OUTPUT is a
 *   search-results payload (see `parseWebSearchOutput`) — its first result is
 *   the page the search actually surfaced. Using it (rather than the raw
 *   query text) is what lets a search-then-fetch of the same page collapse
 *   to one entry: if the agent later fetches that exact URL, both calls
 *   resolve to the same normalized key.
 * - A search with no parseable result (or a call with no `url` at all) falls
 *   back to the query text, its own distinct entry — there is nothing more
 *   concrete to show, but it is still a fallback, never a bare identifier.
 */
function webSourceOf(part: ToolPart): { url: string; label: string } | null {
  const t = normalizeName(part.tool);
  const input = (part.state?.input ?? {}) as Record<string, unknown>;

  if (t === 'web_search' || t === 'websearch' || t === 'image_search') {
    const firstResult = parseWebSearchOutput(rawOutputOf(part)).flatMap((r) => r.sources)[0];
    if (firstResult?.url) {
      return { url: firstResult.url, label: firstResult.title || wsDomain(firstResult.url) };
    }
    const query = typeof input.query === 'string' ? input.query : '';
    return query ? { url: '', label: query } : null;
  }

  // web_fetch / webfetch / scrape_webpage / scrapewebpage — identified by
  // the page it targeted. The label is the real page title when the fetch's
  // own output is parseable HTML; otherwise the domain — never the raw URL.
  const url = typeof input.url === 'string' ? input.url : '';
  if (!url) return null;
  return { url, label: titleFromFetchOutput(part) || wsDomain(url) };
}

export function deriveContext(parts: ToolPart[]): {
  files: ContextItem[];
  web: ContextItem[];
  tools: ContextItem[];
} {
  const files: ContextItem[] = [];
  const web: ContextItem[] = [];
  const tools: ContextItem[] = [];
  const seenFiles = new Set<string>();
  const seenWeb = new Set<string>();
  const seenTools = new Map<string, ContextItem>();

  for (const part of parts) {
    // A failed call didn't successfully look at anything — it must not
    // surface as something the agent inspected either (a failed read never
    // actually saw the file's contents, a failed fetch never saw the page).
    if (statusOf(part) === 'error') continue;

    const family = familyForTool(part.tool);
    if (family === 'hidden') continue; // context-engine bookkeeping — never shown

    const tool = normalizeName(part.tool);

    if (tool === 'read') {
      const path = filePathOf(part) ?? getToolPrimaryArg(part);
      if (!path || seenFiles.has(path)) continue;
      seenFiles.add(path);
      files.push({ callID: part.callID, label: getToolPrimaryArg(part) || path, kind: 'file' });
      continue;
    }

    // A write is something the agent MADE, not something it looked at —
    // Outputs owns it, not Context, even though it also "touches" a file.
    // `create` (image_gen/video_gen/presentation_gen/show/show_user) is the
    // same story — an image/video/presentation/result the agent produced —
    // so it gets the exact same treatment, or it double-counts: once in
    // Outputs, again here as e.g. "Image Gen".
    if (family === 'edit' || family === 'create') continue;

    if (family === 'web') {
      const source = webSourceOf(part);
      if (!source) continue;
      // Dedup by the normalized URL when one is known (a search that
      // surfaced the exact page a later fetch visited collapses here);
      // otherwise fall back to the label itself (a bare query has no URL).
      const key = source.url ? normalizeUrl(source.url) : `q:${source.label}`;
      if (seenWeb.has(key)) continue;
      seenWeb.add(key);
      web.push({
        callID: part.callID,
        label: source.label,
        kind: 'web',
        url: source.url || undefined,
      });
      continue;
    }

    // Everything else is recorded once, by name, as "a tool that was used".
    // Every call to that tool rides along on `parts` so the UI can show what
    // the tool actually did when the user asks — one chip, all its calls.
    const label = humanizeToolName(part.tool);
    const seen = seenTools.get(label);
    if (seen) {
      (seen.parts ??= []).push(part);
      continue;
    }
    const item: ContextItem = { callID: part.callID, label, kind: 'tool', parts: [part] };
    seenTools.set(label, item);
    tools.push(item);
  }

  return { files, web, tools };
}
