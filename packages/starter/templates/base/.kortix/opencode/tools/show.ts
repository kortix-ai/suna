import { tool } from "@opencode-ai/plugin";
import { existsSync } from "fs";
import { resolve } from "path";

// ── Types ──────────────────────────────────────────────────────────────────

/** Content types the show tool can present. */
const TYPES = [
  "file",
  "image",
  "url",
  "text",
  "error",
  "video",
  "audio",
  "code",
  "markdown",
  "pdf",
  "html",
  "csv",
  "xlsx",
  "docx",
  "pptx",
] as const;
type ShowType = (typeof TYPES)[number];

/** Display variants that control how the frontend renders the output. */
const VARIANTS = [
  "compact",   // Minimal inline card — small footprint in the conversation
  "full",      // Full available space — ideal for URL previews, HTML, PDFs
  "gallery",   // Visual-first — centers content with proper aspect ratio
  "detail",    // Rich layout — prominent title, description, content sections
] as const;
type ShowVariant = (typeof VARIANTS)[number];

/** Aspect ratio presets for visual content. */
const ASPECT_RATIOS = [
  "auto",
  "1:1",
  "16:9",
  "9:16",
  "4:3",
  "3:2",
  "21:9",
] as const;
type ShowAspectRatio = (typeof ASPECT_RATIOS)[number];

/** Visual theme for the output card. */
const THEMES = [
  "default",
  "success",
  "warning",
  "info",
  "danger",
] as const;
type ShowTheme = (typeof THEMES)[number];

interface ShowEntry {
  id: string;
  timestamp: string;
  type: ShowType;
  title?: string;
  description?: string;
  path?: string;
  url?: string;
  content?: string;
  variant?: ShowVariant;
  aspect_ratio?: ShowAspectRatio;
  theme?: ShowTheme;
  language?: string;
  metadata?: Record<string, unknown>;
}

function generateId(): string {
  return `show_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/** Infer a sensible default variant based on content type. */
function defaultVariant(type: ShowType): ShowVariant {
  switch (type) {
    case "url":
    case "html":
    case "pdf":
      return "full";
    case "image":
    case "video":
      return "gallery";
    case "code":
    case "markdown":
    case "text":
      return "detail";
    case "csv":
    case "xlsx":
      return "full";
    case "docx":
    case "pptx":
      return "full";
    case "audio":
    case "file":
      return "compact";
    case "error":
      return "compact";
    default:
      return "detail";
  }
}

// ── Shared validation ──────────────────────────────────────────────────────

const PATH_TYPES: ShowType[] = ["file", "image", "video", "audio", "pdf", "csv", "xlsx", "docx", "pptx"];
const CONTENT_TYPES: ShowType[] = ["text", "error", "code", "markdown", "html"];

function validateAndBuildEntry(item: Record<string, unknown>): string | ShowEntry {
  const type = item.type as ShowType | undefined;
  if (!type || !TYPES.includes(type as ShowType)) {
    return `Error: 'type' is required. Use one of: ${TYPES.join(", ")}.`;
  }

  if (PATH_TYPES.includes(type) && !item.path) {
    return `Error: 'path' is required when type is '${type}'.`;
  }
  if (type === "url" && !item.url) {
    return `Error: 'url' is required when type is 'url'.`;
  }
  if (CONTENT_TYPES.includes(type) && !item.content) {
    return `Error: 'content' is required when type is '${type}'.`;
  }

  if (PATH_TYPES.includes(type) && item.path) {
    const absPath = resolve(item.path as string);
    if (!existsSync(absPath)) {
      return `Error: File not found: ${absPath}`;
    }
  }

  const variant = (item.variant as ShowVariant) || undefined;
  if (variant && !VARIANTS.includes(variant)) {
    return `Error: Invalid variant '${variant}'. Use one of: ${VARIANTS.join(", ")}.`;
  }

  const aspectRatio = (item.aspect_ratio as ShowAspectRatio) || undefined;
  if (aspectRatio && !ASPECT_RATIOS.includes(aspectRatio)) {
    return `Error: Invalid aspect_ratio '${aspectRatio}'. Use one of: ${ASPECT_RATIOS.join(", ")}.`;
  }

  const theme = (item.theme as ShowTheme) || undefined;
  if (theme && !THEMES.includes(theme)) {
    return `Error: Invalid theme '${theme}'. Use one of: ${THEMES.join(", ")}.`;
  }

  let metadata: Record<string, unknown> | undefined;
  if (item.metadata) {
    if (typeof item.metadata === "string") {
      try {
        metadata = JSON.parse(item.metadata);
      } catch {
        return `Error: Invalid JSON in 'metadata' parameter.`;
      }
    } else if (typeof item.metadata === "object") {
      metadata = item.metadata as Record<string, unknown>;
    }
  }

  const resolvedVariant = variant || defaultVariant(type);

  return {
    id: generateId(),
    timestamp: new Date().toISOString(),
    type,
    variant: resolvedVariant,
    ...(item.title ? { title: item.title as string } : {}),
    ...(item.description ? { description: item.description as string } : {}),
    ...(item.path ? { path: resolve(item.path as string) } : {}),
    ...(item.url ? { url: item.url as string } : {}),
    ...(item.content ? { content: item.content as string } : {}),
    ...(aspectRatio ? { aspect_ratio: aspectRatio } : {}),
    ...(theme && theme !== "default" ? { theme } : {}),
    ...(item.language ? { language: item.language as string } : {}),
    ...(metadata ? { metadata } : {}),
  };
}

// ── Tool definition ────────────────────────────────────────────────────────

export default tool({
  description:
    "Show outputs and attachments to the human user. This tool PRESENTS and DISPLAYS existing content — " +
    "it is NOT a place to author or store artifacts. Show should SHOW, not be where you write.\n\n" +
    "CRITICAL RULE: Do not use show to write new artifacts from scratch. If you need to create a " +
    "spec, report, plan, document, config, or any authored content — write it to a file first " +
    "using the Write tool, then present it with show(type='file', path='...'). " +
    "The 'content' parameter is for communicating brief information inline (status, summaries, " +
    "snippets, errors, previews) — not for authoring documents.\n\n" +
    "Good: Write spec to /workspace/spec.md → show(type='file', path='/workspace/spec.md')\n" +
    "Good: show(type='text', content='Build succeeded in 3.2s')\n" +
    "Good: show(type='code', content='const x = 1;', language='typescript')\n" +
    "Bad: show(type='markdown', content='# Full spec written from scratch here...') — write to file first!\n\n" +
    "Types: file, image, url, text, error, video, audio, code, markdown, pdf, html, csv, xlsx, docx, pptx.\n" +
    "IMPORTANT HTML NOTE: type='html' renders INLINE HTML from the 'content' field only. " +
    "If you have a standalone .html file on disk, it is NOT auto-hosted or auto-opened by a viewer. " +
    "Use type='url' and point to a running web server URL that serves that file. " +
    "A default static server runs at http://localhost:3211 (for example: http://localhost:3211/open?path=/workspace/site/index.html).\n" +
    "Variants (display hints): compact, full, gallery, detail — controls layout. " +
    "Defaults are smart per type but can be overridden.\n" +
    "aspect_ratio: auto, 1:1, 16:9, 9:16, 4:3, 3:2, 21:9 — for visual content.\n" +
    "theme: default, success, warning, info, danger — visual accent.\n" +
    "language: for type='code', the language for syntax highlighting (e.g. 'python', 'typescript').\n\n" +
    "MULTI-ITEM MODE: To show multiple items at once (rendered as a carousel), pass a JSON array " +
    "string to the 'items' parameter instead of individual type/path/url/content params. " +
    "Each item in the array is an object with the same fields (type, title, path, url, content, etc.).",
  args: {
    action: tool.schema
      .string()
      .describe("Action: 'show' to present an item to the user."),

    type: tool.schema
      .string()
      .optional()
      .describe(
        "Type of item. Required for single-item 'show' (omit when using 'items'). " +
          "Options: 'file' (any file on disk), 'image' (image file), 'url' (web link or localhost preview), " +
          "'text' (inline text), 'error' (error message), 'video' (video file), 'audio' (audio file), " +
          "'code' (syntax-highlighted code block), 'markdown' (rendered markdown), " +
          "'pdf' (PDF document), 'html' (raw HTML rendered in sandboxed iframe), " +
          "'csv' (CSV/TSV tabular data), 'xlsx' (Excel spreadsheet), " +
          "'docx' (Word document), 'pptx' (PowerPoint presentation).",
      ),

    title: tool.schema
      .string()
      .optional()
      .describe("Short heading. E.g. 'Generated Logo', 'API Response', 'Build Output'."),

    description: tool.schema
      .string()
      .optional()
      .describe(
        "Longer description shown below the title. E.g. 'A 1024x1024 logo in your brand colors'.",
      ),

    path: tool.schema
      .string()
      .optional()
      .describe(
        "Absolute file path. Required when type is 'file', 'image', 'video', 'audio', 'pdf', 'csv', 'xlsx', 'docx', or 'pptx'. " +
          "E.g. '/workspace/output/logo.png'. Note: passing a .html path as type='file' does not host/execute it; " +
          "serve it via a web server and use type='url' for live HTML pages (default: http://localhost:3211/open?path=/absolute/file.html).",
      ),

    url: tool.schema
      .string()
      .optional()
      .describe(
        "URL to show. Required when type is 'url'. Use for localhost previews (e.g. 'http://localhost:3000') " +
          "or external links. For standalone HTML files, first serve them via a web server, then pass the served URL here.",
      ),

    content: tool.schema
      .string()
      .optional()
      .describe(
        "Inline content for display. Required when type is 'text', 'error', 'code', 'markdown', or 'html'. " +
        "Use this to communicate information briefly — not to author full artifacts from scratch. " +
        "If the content is a new document you're creating (spec, report, plan, etc.), write it to a file first and use type='file' with path. " +
        "For 'html', inline HTML rendered in a sandboxed iframe (not a file path).",
      ),

    variant: tool.schema
      .string()
      .optional()
      .describe(
        "Display variant controlling the layout. Options: " +
          "'compact' (minimal inline card), 'full' (fills available space — great for previews), " +
          "'gallery' (visual-first, centered with aspect ratio — great for images/video), " +
          "'detail' (rich layout with prominent title, description, content). " +
          "Smart defaults per type if omitted.",
      ),

    aspect_ratio: tool.schema
      .string()
      .optional()
      .describe(
        "Aspect ratio for visual content. Options: 'auto' (default), '1:1', '16:9', '9:16', '4:3', '3:2', '21:9'. " +
          "Most useful with type='image' or type='video' + variant='gallery'.",
      ),

    theme: tool.schema
      .string()
      .optional()
      .describe(
        "Visual accent theme. Options: 'default', 'success' (green), 'warning' (amber), " +
          "'info' (blue), 'danger' (red). Affects the border/badge colors.",
      ),

    language: tool.schema
      .string()
      .optional()
      .describe(
        "Programming language for syntax highlighting. Only used when type='code'. " +
          "E.g. 'python', 'typescript', 'rust', 'json', 'bash'.",
      ),

    metadata: tool.schema
      .string()
      .optional()
      .describe(
        "Optional JSON string of extra metadata. E.g. '{\"width\":1024,\"format\":\"png\",\"duration\":\"3:42\"}'.",
      ),

    items: tool.schema
      .string()
      .optional()
      .describe(
        "JSON array of items to show as a carousel. Each item is an object with: " +
          "type (required), title, description, path, url, content, variant, aspect_ratio, theme, language, metadata. " +
          "When provided, individual type/path/url/content params are ignored. " +
          'Example: \'[{"type":"image","title":"Logo v1","path":"/workspace/v1.png"},{"type":"image","title":"Logo v2","path":"/workspace/v2.png"}]\'',
      ),
  },

  async execute(args, _context) {
    const action = args.action;

    // ── Multi-item mode (items array) ──
    if (args.items) {
      let parsed: unknown;
      try {
        parsed = typeof args.items === "string" ? JSON.parse(args.items) : args.items;
      } catch {
        return `Error: Invalid JSON in 'items' parameter. Must be a JSON array of objects.`;
      }

      if (!Array.isArray(parsed) || parsed.length === 0) {
        return `Error: 'items' must be a non-empty JSON array.`;
      }

      const entries: ShowEntry[] = [];
      const errors: string[] = [];

      for (let i = 0; i < parsed.length; i++) {
        const item = parsed[i];
        if (!item || typeof item !== "object") {
          errors.push(`Item ${i}: must be an object.`);
          continue;
        }
        const result = validateAndBuildEntry(item as Record<string, unknown>);
        if (typeof result === "string") {
          errors.push(`Item ${i}: ${result}`);
        } else {
          entries.push(result);
        }
      }

      if (errors.length > 0 && entries.length === 0) {
        return `Error: All items failed validation:\n${errors.join("\n")}`;
      }

      const titleLabel = args.title || `${entries.length} items`;

      return JSON.stringify(
        {
          success: true,
          action: "show",
          ...(args.title && { title: args.title }),
          ...(args.description && { description: args.description }),
          ...(args.theme && args.theme !== "default" && { theme: args.theme }),
          items: entries,
          ...(errors.length > 0 && { warnings: errors }),
          message: `${entries.length} item(s) presented to user as carousel.`,
        },
        null,
        2,
      );
    }

    // ── Single-item mode (type is provided directly) ──
    const type = args.type as ShowType | undefined;
    if (!type || !TYPES.includes(type as ShowType)) {
      return `Error: 'type' is required for 'show' action. Use one of: ${TYPES.join(", ")}. Or pass 'items' for multi-item carousel.`;
    }

    const result = validateAndBuildEntry(args);
    if (typeof result === "string") return result;

    return JSON.stringify(
      {
        success: true,
        action: "show",
        entry: result,
        message: `Item '${args.title || type}' presented to user.`,
      },
      null,
      2,
    );
  },
});
