import { GENUI_SPECS } from './catalog';
import { splitGenui } from './fence';
import { parseGenui } from './parse';
import { GENUI_SCHEMA_VERSION, type GenuiNode } from './types';

/** Shown in place of a block this build cannot read (a newer schema version). */
export const GENUI_UNSUPPORTED_NOTE = 'This content needs a newer version of Kortix.';

/** Shown under a block whose stream ended inside a statement. */
export const GENUI_CUT_OFF_NOTE = 'Response was cut off.';

/** Deterministic markdown for one node and its children. Unknown types yield ''. */
export function genuiNodeToMarkdown(node: GenuiNode): string {
  const spec = GENUI_SPECS[node.type];
  return spec ? spec.toMarkdown(node.props, genuiNodeToMarkdown) : '';
}

/** Screen-reader text for a chart or map node, else null. */
export function genuiA11yText(node: GenuiNode): string | null {
  return GENUI_SPECS[node.type]?.a11y?.(node.props) ?? null;
}

/** Markdown for one finished block. Never returns OpenUI source. */
export function genuiBlockToMarkdown(code: string, version: number = GENUI_SCHEMA_VERSION): string {
  if (version !== GENUI_SCHEMA_VERSION) return `*${GENUI_UNSUPPORTED_NOTE}*`;
  const { root, issues } = parseGenui(code, version);
  const body = root ? genuiNodeToMarkdown(root) : '';
  const cutOff = issues.some((issue) => issue.code === 'cut-off');
  return cutOff ? [body, `*${GENUI_CUT_OFF_NOTE}*`].filter(Boolean).join('\n\n') : body;
}

/**
 * A whole reply as plain markdown: every generative-UI block replaced by its markdown.
 * For copy, export, the CLI, chat channels, and any host that does not render UI.
 * Text without a generative-UI fence is returned unchanged (same string).
 */
export function genuiToMarkdown(text: string): string {
  if (!/openui/i.test(text)) return text;
  const segments = splitGenui(text);
  if (!segments.some((segment) => segment.kind === 'genui')) return text;
  return segments
    .map((segment) =>
      segment.kind === 'markdown'
        ? segment.text.replace(/^\n+|\n+$/g, '')
        : genuiBlockToMarkdown(segment.code, segment.version),
    )
    .filter((part) => part.trim().length > 0)
    .join('\n\n');
}
