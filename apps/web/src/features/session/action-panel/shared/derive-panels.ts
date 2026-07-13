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
import { getToolPrimaryArg, normalizeName } from '../../tool/tool-meta';
import type { PatchFileLite } from '../../tool/shared/patch-helpers';
import { parsePresentationOutput } from '../../tool/shared/presentation-helpers';
import { parseImageOutput } from '../../image-output-path';
import { extractReadableHtml } from '../../tool/tool-renderers-sanitization';
import { looksLikeHtml, parseWebSearchOutput, wsDomain } from '../../tool/shared/web-helpers';
import { createArtifactKind, familyForTool, humanizeToolName } from './narration';

export interface OutputItem {
  callID: string;
  name: string;
  path?: string;
  kind: 'file' | 'image' | 'video' | 'presentation';
}

export interface ContextItem {
  callID: string;
  label: string;
  kind: 'file' | 'web' | 'tool';
  /** The real URL a `web` item points at — never rendered as the label
   * itself, only as a title attribute / link target for the row. */
  url?: string;
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

export function deriveOutputs(parts: ToolPart[]): OutputItem[] {
  const out: OutputItem[] = [];
  const seen = new Set<string>();

  for (const part of parts) {
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
      // image_gen / video_gen / presentation_gen / show / show_user — ask
      // narration.ts's own action tables whether this specific call made
      // anything, rather than assuming every call to these tool names did.
      const kind = createArtifactKind(part);
      if (!kind) continue;
      const { name, path } = createArtifactName(part);
      out.push({ callID: part.callID, name, path, kind });
    }
  }

  return out;
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
  const seenTools = new Set<string>();

  for (const part of parts) {
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
    const label = humanizeToolName(part.tool);
    if (seenTools.has(label)) continue;
    seenTools.add(label);
    tools.push({ callID: part.callID, label, kind: 'tool' });
  }

  return { files, web, tools };
}
