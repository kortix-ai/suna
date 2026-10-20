/**
 * Pure helpers for the `.mmd` / `.mermaid` file preview. Kept free of React and
 * of `mermaid` itself so they can be unit-tested without a DOM.
 */

export const MERMAID_FILE_EXT_RE = /\.(mmd|mermaid)$/i;

/** Whether a file name or path is a standalone Mermaid diagram file. */
export function isMermaidFile(fileName: string): boolean {
  return MERMAID_FILE_EXT_RE.test(fileName);
}

/** The name the rendered SVG downloads under: `flow.mmd` → `flow.svg`. */
export function mermaidSvgFileName(fileName: string): string {
  const base = fileName.split('/').pop() || 'diagram';
  return MERMAID_FILE_EXT_RE.test(base) ? base.replace(MERMAID_FILE_EXT_RE, '.svg') : `${base}.svg`;
}

/**
 * Whether the source sets its own Mermaid config — an `%%{init: …}%%`
 * directive or a YAML front-matter `config:` block. When it does, the author
 * chose the theme, so the viewer does not inject one.
 */
export function hasOwnMermaidConfig(source: string): boolean {
  if (/%%\{\s*init(ialize)?\s*:/i.test(source)) return true;
  const front = /^\s*---\r?\n([\s\S]*?)\r?\n---/.exec(source);
  return !!front && hasConfigLine(front[1] ?? '');
}

const isSpace = (text: string, at: number) => at < text.length && /\s/.test(text[at] ?? '');
const isLineBreak = (text: string, at: number) => at < text.length && !/./.test(text[at] ?? '');

/**
 * Whether a line starts with `config:` after any whitespace, as
 * `/^\s*config\s*:/m` found it. `\s*` crosses lines, so every line start
 * inside a blank run reaches the same text: the regex retried each one, and
 * 240k blank lines took 23 s. Here each run is read once.
 */
function hasConfigLine(yaml: string): boolean {
  for (let at = 0; at <= yaml.length; ) {
    let key = at;
    while (isSpace(yaml, key)) key++;
    if (yaml.startsWith('config', key)) {
      let colon = key + 6;
      while (isSpace(yaml, colon)) colon++;
      if (yaml[colon] === ':') return true;
    }
    // The next line start after the whitespace run.
    let end = key;
    while (end < yaml.length && !isLineBreak(yaml, end)) end++;
    at = end + 1;
  }
  return false;
}

/**
 * Append the viewer's theme directive to the source.
 *
 * Appended, never prepended: YAML front matter must stay the first line, and
 * Mermaid reads directives from anywhere in the text. Appending also keeps the
 * line numbers in a parse error equal to the line numbers in the file.
 *
 * `htmlLabels: false` makes every label plain SVG `<text>`. The diagram is
 * shown through an `<img>`, and an `<img>` does not render the HTML inside a
 * `<foreignObject>` consistently across browsers. The font stack is the system
 * one for the same reason: an `<img>` cannot load the page's web fonts, so the
 * text is measured and drawn with the same fonts.
 */
export function withViewerTheme(source: string, dark: boolean): string {
  if (hasOwnMermaidConfig(source)) return source;
  const fontFamily = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';
  const init = {
    theme: dark ? 'dark' : 'neutral',
    fontFamily,
    htmlLabels: false,
    flowchart: { htmlLabels: false },
    themeVariables: { fontFamily },
  };
  return `${source}\n%%{init: ${JSON.stringify(init)}}%%\n`;
}

export interface MermaidParseError {
  message: string;
  /** 1-indexed source line, when Mermaid reports one. */
  line: number | null;
}

/** Normalize whatever `mermaid.parse` threw into a message and a line number. */
export function toMermaidParseError(err: unknown): MermaidParseError {
  const raw =
    err instanceof Error
      ? err.message
      : typeof err === 'string'
        ? err
        : String((err as { message?: unknown })?.message ?? 'Unknown error');
  const message = raw.trim() || 'Unknown error';

  const fromMessage = /\bline (\d+)\b/i.exec(message);
  if (fromMessage) return { message, line: Number(fromMessage[1]) };

  // Jison parsers attach the location to `hash`. `first_line` is 1-indexed.
  const loc = (err as { hash?: { loc?: { first_line?: unknown } } })?.hash?.loc;
  if (typeof loc?.first_line === 'number') return { message, line: loc.first_line };

  if (/no diagram type detected/i.test(message)) return { message, line: 1 };
  return { message, line: null };
}

/**
 * Give the SVG a fixed intrinsic size so an `<img>` can fit it.
 *
 * Mermaid emits `width="100%"` plus a `max-width` style. Inside an `<img>`
 * that has no intrinsic width, so the browser falls back to 300×150. The
 * `viewBox` holds the real size.
 */
export function withIntrinsicSize(svg: string): string {
  const open = /<svg\b[^>]*>/i.exec(svg);
  if (!open) return svg;
  const viewBox = /\bviewBox="\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)\s*"/i.exec(
    open[0],
  );
  if (!viewBox) return svg;
  const [, width, height] = viewBox;
  const tag = open[0]
    .replace(/\s(width|height)="[^"]*"/gi, '')
    .replace(/\sstyle="[^"]*"/i, '')
    .replace(/^<svg\b/i, `<svg width="${width}" height="${height}"`);
  return svg.slice(0, open.index) + tag + svg.slice(open.index + open[0].length);
}
