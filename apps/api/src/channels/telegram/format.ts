/**
 * Pure formatting for the Telegram relay: agent markdown → Telegram-safe HTML,
 * 4096-char chunking on natural boundaries, the live "working" status message,
 * and the session deep link. No I/O — everything here is unit-tested.
 */

/** Telegram sendMessage hard limit. */
export const TELEGRAM_MAX_MESSAGE = 4096;

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Convert the markdown agents write into Telegram's supported HTML subset
 * (<b> <i> <code> <pre> <a> <blockquote>). Anything richer degrades to plain
 * text lines: headings become bold lines, list markers stay literal (they read
 * fine in chat), tables/images pass through as text. The output is always
 * fully escaped, so a parse failure can only come from Telegram-side limits —
 * callers still keep a plain-text fallback.
 */
export function telegramHtml(markdown: string): string {
  const out: string[] = [];
  // Fenced code blocks are handled first so nothing inside them is styled.
  const parts = markdown.split(/```([^\n`]*)\n?([\s\S]*?)```/g);
  // split() with two capture groups yields [text, lang, code, text, lang, code, …]
  for (let i = 0; i < parts.length; i += 3) {
    const text = parts[i] ?? '';
    out.push(inlineMd(text));
    const code = parts[i + 2];
    if (code !== undefined) {
      out.push(`<pre>${escapeHtml(code.replace(/\n$/, ''))}</pre>`);
    }
  }
  return out.join('').trim();
}

function inlineMd(text: string): string {
  const lines = text.split('\n').map((line) => {
    // Headings → bold lines (Telegram has no heading element).
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) return `<b>${inlineSpans(h[2])}</b>`;
    // Blockquotes.
    const q = /^>\s?(.*)$/.exec(line);
    if (q) return `<blockquote>${inlineSpans(q[1])}</blockquote>`;
    return inlineSpans(line);
  });
  return lines.join('\n');
}

function inlineSpans(text: string): string {
  let s = escapeHtml(text);
  // Inline code first — its content must not be styled further.
  s = s.replace(/`([^`\n]+)`/g, (_m, code: string) => `<code>${code}</code>`);
  // Links: [label](https://…) — http(s) only; anything else stays literal text.
  s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, (_m, label: string, url: string) => {
    return `<a href="${url.replace(/"/g, '%22')}">${label}</a>`;
  });
  // Bold then italic (bold uses ** so it must run before single *).
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
  s = s.replace(/(^|[^\w*])\*([^*\n]+)\*(?=[^\w*]|$)/g, '$1<i>$2</i>');
  s = s.replace(/(^|[^\w_])_([^_\n]+)_(?=[^\w_]|$)/g, '$1<i>$2</i>');
  return s;
}

/**
 * Split a message at Telegram's 4096 limit, preferring paragraph breaks, then
 * line breaks, then a hard cut. Never splits inside an HTML tag pair? — we
 * don't try: chunked answers are sent as PLAIN text by the relay when more
 * than one chunk is needed, precisely so a split can't produce broken HTML.
 */
export function chunkTelegramText(text: string, max = TELEGRAM_MAX_MESSAGE): string[] {
  if (text.length <= max) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > max) {
    const window = rest.slice(0, max);
    let cut = window.lastIndexOf('\n\n');
    if (cut < max * 0.5) cut = window.lastIndexOf('\n');
    if (cut < max * 0.5) cut = max;
    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

/** One step line in the live status message. */
export interface TelegramTurnStep {
  title: string;
  done: boolean;
}

/**
 * The live "working" view — the Telegram-native cousin of Slack's streaming
 * plan: finished steps get a check, the current one an hourglass. Kept to the
 * last few steps so the status message stays chat-sized.
 */
export function renderWorkingStatus(steps: TelegramTurnStep[], maxSteps = 6): string {
  if (steps.length === 0) return '⏳ <i>Working on it…</i>';
  const visible = steps.slice(-maxSteps);
  const hidden = steps.length - visible.length;
  const lines = visible.map(
    (s) => `${s.done ? '✅' : '⏳'} ${escapeHtml(s.title)}`,
  );
  const head = hidden > 0 ? [`<i>…${hidden} earlier step${hidden === 1 ? '' : 's'}</i>`] : [];
  return [...head, ...lines].join('\n');
}

/** Dashboard deep link for the "Open in Kortix" button. Only https bases
 *  qualify — Telegram rejects buttons with invalid/insecure URLs. */
export function sessionDeepLink(
  base: string | undefined | null,
  projectId: string,
  sessionId: string,
): string | null {
  const trimmed = (base ?? '').replace(/\/+$/, '');
  if (!/^https:\/\//.test(trimmed)) return null;
  return `${trimmed}/projects/${projectId}/sessions/${sessionId}`;
}
