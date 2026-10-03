/**
 * show: present an existing output (a file, an image, a URL, inline text) to
 * the user. The same tool the project template gives an OpenCode session,
 * under the same name, arguments and output JSON, so the client's show card
 * renders a pi call unchanged. A relative `path` resolves against the project
 * checkout.
 */
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { Type } from 'typebox'

/** Content types the show tool can present. */
const TYPES = [
  'file',
  'image',
  'url',
  'text',
  'error',
  'video',
  'audio',
  'code',
  'markdown',
  'pdf',
  'html',
  'csv',
  'xlsx',
  'docx',
  'pptx',
] as const
type ShowType = (typeof TYPES)[number]

/** Display variants that control how the frontend renders the output. */
const VARIANTS = [
  'compact',   // Minimal inline card — small footprint in the conversation
  'full',      // Full available space — ideal for URL previews, HTML, PDFs
  'gallery',   // Visual-first — centers content with proper aspect ratio
  'detail',    // Rich layout — prominent title, description, content sections
] as const
type ShowVariant = (typeof VARIANTS)[number]

/** Aspect ratio presets for visual content. */
const ASPECT_RATIOS = [
  'auto',
  '1:1',
  '16:9',
  '9:16',
  '4:3',
  '3:2',
  '21:9',
] as const
type ShowAspectRatio = (typeof ASPECT_RATIOS)[number]

/** Visual theme for the output card. */
const THEMES = [
  'default',
  'success',
  'warning',
  'info',
  'danger',
] as const
type ShowTheme = (typeof THEMES)[number]

interface ShowEntry {
  id: string
  timestamp: string
  type: ShowType
  title?: string
  description?: string
  path?: string
  url?: string
  content?: string
  variant?: ShowVariant
  aspect_ratio?: ShowAspectRatio
  theme?: ShowTheme
  language?: string
  metadata?: Record<string, unknown>
}

function generateId(): string {
  return `show_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

/** Infer a sensible default variant based on content type. */
function defaultVariant(type: ShowType): ShowVariant {
  switch (type) {
    case 'url':
    case 'html':
    case 'pdf':
      return 'full'
    case 'image':
    case 'video':
      return 'gallery'
    case 'code':
    case 'markdown':
    case 'text':
      return 'detail'
    case 'csv':
    case 'xlsx':
      return 'full'
    case 'docx':
    case 'pptx':
      return 'full'
    case 'audio':
    case 'file':
      return 'compact'
    case 'error':
      return 'compact'
    default:
      return 'detail'
  }
}

// ── Shared validation ──────────────────────────────────────────────────────

const PATH_TYPES: ShowType[] = ['file', 'image', 'video', 'audio', 'pdf', 'csv', 'xlsx', 'docx', 'pptx']
const CONTENT_TYPES: ShowType[] = ['text', 'error', 'code', 'markdown', 'html']

function validateAndBuildEntry(item: Record<string, unknown>, dir: string): string | ShowEntry {
  const type = item.type as ShowType | undefined
  if (!type || !TYPES.includes(type as ShowType)) {
    return `'type' is required. Use one of: ${TYPES.join(', ')}.`
  }

  if (PATH_TYPES.includes(type) && !item.path) {
    return `'path' is required when type is '${type}'.`
  }
  if (type === 'url' && !item.url) {
    return `'url' is required when type is 'url'.`
  }
  if (CONTENT_TYPES.includes(type) && !item.content) {
    return `'content' is required when type is '${type}'.`
  }

  if (PATH_TYPES.includes(type) && item.path) {
    const absPath = resolve(dir, item.path as string)
    if (!existsSync(absPath)) {
      return `File not found: ${absPath}`
    }
  }

  const variant = (item.variant as ShowVariant) || undefined
  if (variant && !VARIANTS.includes(variant)) {
    return `Invalid variant '${variant}'. Use one of: ${VARIANTS.join(', ')}.`
  }

  const aspectRatio = (item.aspect_ratio as ShowAspectRatio) || undefined
  if (aspectRatio && !ASPECT_RATIOS.includes(aspectRatio)) {
    return `Invalid aspect_ratio '${aspectRatio}'. Use one of: ${ASPECT_RATIOS.join(', ')}.`
  }

  const theme = (item.theme as ShowTheme) || undefined
  if (theme && !THEMES.includes(theme)) {
    return `Invalid theme '${theme}'. Use one of: ${THEMES.join(', ')}.`
  }

  let metadata: Record<string, unknown> | undefined
  if (item.metadata) {
    if (typeof item.metadata === 'string') {
      try {
        metadata = JSON.parse(item.metadata)
      } catch {
        return `Invalid JSON in 'metadata' parameter.`
      }
    } else if (typeof item.metadata === 'object') {
      metadata = item.metadata as Record<string, unknown>
    }
  }

  const resolvedVariant = variant || defaultVariant(type)

  return {
    id: generateId(),
    timestamp: new Date().toISOString(),
    type,
    variant: resolvedVariant,
    ...(item.title ? { title: item.title as string } : {}),
    ...(item.description ? { description: item.description as string } : {}),
    ...(item.path ? { path: resolve(dir, item.path as string) } : {}),
    ...(item.url ? { url: item.url as string } : {}),
    ...(item.content ? { content: item.content as string } : {}),
    ...(aspectRatio ? { aspect_ratio: aspectRatio } : {}),
    ...(theme && theme !== 'default' ? { theme } : {}),
    ...(item.language ? { language: item.language as string } : {}),
    ...(metadata ? { metadata } : {}),
  }
}

// ── Tool definition ────────────────────────────────────────────────────────

const SERVE_EXAMPLE = '`nohup python3 -m http.server 3000 --directory /workspace/site >/tmp/site.log 2>&1 &`'

const showSchema = Type.Object({
  action: Type.String({ description: "Action: 'show' to present an item to the user." }),
  type: Type.Optional(
    Type.String({
      description:
        "Type of item. Required for single-item 'show' (omit when using 'items'). " +
        "Options: 'file' (any file on disk), 'image' (image file), 'url' (web link or localhost preview), " +
        "'text' (inline text), 'error' (error message), 'video' (video file), 'audio' (audio file), " +
        "'code' (syntax-highlighted code block), 'markdown' (rendered markdown), " +
        "'pdf' (PDF document), 'html' (raw HTML rendered in sandboxed iframe), " +
        "'csv' (CSV/TSV tabular data), 'xlsx' (Excel spreadsheet), " +
        "'docx' (Word document), 'pptx' (PowerPoint presentation).",
    }),
  ),
  title: Type.Optional(Type.String({ description: "Short heading. E.g. 'Generated Logo', 'API Response', 'Build Output'." })),
  description: Type.Optional(
    Type.String({ description: "Longer description shown below the title. E.g. 'A 1024x1024 logo in your brand colors'." }),
  ),
  path: Type.Optional(
    Type.String({
      description:
        "Absolute file path. Required when type is 'file', 'image', 'video', 'audio', 'pdf', 'csv', 'xlsx', 'docx', or 'pptx'. " +
        "E.g. '/workspace/output/logo.png'. Note: passing a .html path as type='file' does not host/execute it; " +
        `serve it with a local web server (e.g. ${SERVE_EXAMPLE} with bash) and pass its ` +
        "plain http://localhost:PORT/ URL as type='url' for live HTML pages.",
    }),
  ),
  url: Type.Optional(
    Type.String({
      description:
        "URL to show. Required when type is 'url'. Use for localhost previews (e.g. 'http://localhost:3000') " +
        'or external links. For standalone HTML files, first serve them via a web server, then pass the served URL here.',
    }),
  ),
  content: Type.Optional(
    Type.String({
      description:
        "Inline content for display. Required when type is 'text', 'error', 'code', 'markdown', or 'html'. " +
        'Use this to communicate information briefly — not to author full artifacts from scratch. ' +
        "If the content is a new document you're creating (spec, report, plan, etc.), write it to a file first and use type='file' with path. " +
        "For 'html', inline HTML rendered in a sandboxed iframe (not a file path).",
    }),
  ),
  variant: Type.Optional(
    Type.String({
      description:
        'Display variant controlling the layout. Options: ' +
        "'compact' (minimal inline card), 'full' (fills available space — great for previews), " +
        "'gallery' (visual-first, centered with aspect ratio — great for images/video), " +
        "'detail' (rich layout with prominent title, description, content). " +
        'Smart defaults per type if omitted.',
    }),
  ),
  aspect_ratio: Type.Optional(
    Type.String({
      description:
        "Aspect ratio for visual content. Options: 'auto' (default), '1:1', '16:9', '9:16', '4:3', '3:2', '21:9'. " +
        "Most useful with type='image' or type='video' + variant='gallery'.",
    }),
  ),
  theme: Type.Optional(
    Type.String({
      description:
        "Visual accent theme. Options: 'default', 'success' (green), 'warning' (amber), " +
        "'info' (blue), 'danger' (red). Affects the border/badge colors.",
    }),
  ),
  language: Type.Optional(
    Type.String({
      description:
        "Programming language for syntax highlighting. Only used when type='code'. " + "E.g. 'python', 'typescript', 'rust', 'json', 'bash'.",
    }),
  ),
  metadata: Type.Optional(
    Type.String({ description: 'Optional JSON string of extra metadata. E.g. \'{"width":1024,"format":"png","duration":"3:42"}\'.' }),
  ),
  items: Type.Optional(
    Type.String({
      description:
        'JSON array of items to show as a carousel. Each item is an object with: ' +
        'type (required), title, description, path, url, content, variant, aspect_ratio, theme, language, metadata. ' +
        'When provided, individual type/path/url/content params are ignored. ' +
        'Example: \'[{"type":"image","title":"Logo v1","path":"/workspace/v1.png"},{"type":"image","title":"Logo v2","path":"/workspace/v2.png"}]\'',
    }),
  ),
})

/** `dir` is the project checkout a relative `path` resolves against. */
export function createShowTool(dir: string): AgentTool<typeof showSchema, undefined> {
  const shown = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }], details: undefined })
  return {
    name: 'show',
    label: 'show',
    description:
      'Show outputs and attachments to the human user. This tool PRESENTS and DISPLAYS existing content — ' +
      'it is NOT a place to author or store artifacts. Show should SHOW, not be where you write.\n\n' +
      'CRITICAL RULE: Do not use show to write new artifacts from scratch. If you need to create a ' +
      'spec, report, plan, document, config, or any authored content — write it to a file first ' +
      "using the write tool, then present it with show(type='file', path='...'). " +
      "The 'content' parameter is for communicating brief information inline (status, summaries, " +
      'snippets, errors, previews) — not for authoring documents.\n\n' +
      "Good: Write spec to /workspace/spec.md → show(type='file', path='/workspace/spec.md')\n" +
      "Good: show(type='text', content='Build succeeded in 3.2s')\n" +
      "Good: show(type='code', content='const x = 1;', language='typescript')\n" +
      "Bad: show(type='markdown', content='# Full spec written from scratch here...') — write to file first!\n\n" +
      'Types: file, image, url, text, error, video, audio, code, markdown, pdf, html, csv, xlsx, docx, pptx.\n' +
      "IMPORTANT HTML NOTE: type='html' renders INLINE HTML from the 'content' field only. " +
      'A standalone .html file or website on disk is NOT auto-hosted — serve it with a local web server, ' +
      "then pass its plain URL with type='url'. For a static site, start one in the background with bash " +
      `(e.g. ${SERVE_EXAMPLE}); for an app, run its dev server the same way ` +
      "(e.g. `npm run dev`). Then show(type='url', url='http://localhost:3000/'). The platform auto-detects " +
      'and proxies any localhost port — just use a plain http://localhost:PORT/ URL, no special path format needed.\n' +
      'Variants (display hints): compact, full, gallery, detail — controls layout. ' +
      'Defaults are smart per type but can be overridden.\n' +
      'aspect_ratio: auto, 1:1, 16:9, 9:16, 4:3, 3:2, 21:9 — for visual content.\n' +
      'theme: default, success, warning, info, danger — visual accent.\n' +
      "language: for type='code', the language for syntax highlighting (e.g. 'python', 'typescript').\n\n" +
      'MULTI-ITEM MODE: To show multiple items at once (rendered as a carousel), pass a JSON array ' +
      "string to the 'items' parameter instead of individual type/path/url/content params. " +
      'Each item in the array is an object with the same fields (type, title, path, url, content, etc.).\n' +
      'When you have 2 or more outputs to present together (several screenshots, a page and its docs, ' +
      "v1 and v2 of a design), make ONE show call with 'items' — not one show call per output. " +
      'Give each item its own title so the user can tell them apart while paging.',
    parameters: showSchema,
    async execute(_id, args) {
      if (args.items) {
        let parsed: unknown
        try {
          parsed = JSON.parse(args.items)
        } catch {
          throw new Error("Invalid JSON in 'items' parameter. Must be a JSON array of objects.")
        }
        if (!Array.isArray(parsed) || parsed.length === 0) throw new Error("'items' must be a non-empty JSON array.")
        const entries: ShowEntry[] = []
        const errors: string[] = []
        parsed.forEach((item, i) => {
          const result = item && typeof item === 'object' ? validateAndBuildEntry(item as Record<string, unknown>, dir) : 'must be an object.'
          if (typeof result === 'string') errors.push(`Item ${i}: ${result}`)
          else entries.push(result)
        })
        if (entries.length === 0) throw new Error(`All items failed validation:\n${errors.join('\n')}`)
        return shown({
          success: true,
          action: 'show',
          ...(args.title && { title: args.title }),
          ...(args.description && { description: args.description }),
          ...(args.theme && args.theme !== 'default' && { theme: args.theme }),
          items: entries,
          ...(errors.length > 0 && { warnings: errors }),
          message: `${entries.length} item(s) presented to user as carousel.`,
        })
      }
      const entry = validateAndBuildEntry(args, dir)
      if (typeof entry === 'string') throw new Error(entry)
      return shown({ success: true, action: 'show', entry, message: `Item '${args.title || args.type}' presented to user.` })
    },
  }
}
