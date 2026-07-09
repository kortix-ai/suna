/**
 * Central styling primitives for the Kortix CLI.
 */

const ENABLED = process.stdout.isTTY === true && !process.env.NO_COLOR;

function code(seq: string): string {
  return ENABLED ? seq : '';
}

export const C = {
  reset: code('\x1b[0m'),
  bold: code('\x1b[1m'),
  dim: code('\x1b[2m'),
  green: code('\x1b[0;32m'),
  red: code('\x1b[0;31m'),
  cyan: code('\x1b[0;36m'),
  yellow: code('\x1b[1;33m'),
  white: code('\x1b[1;37m'),
  faded: code('\x1b[2;37m'),
} as const;

/** Strip ANSI escape codes from a string. */
export function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

/** Visible character width, ignoring ANSI codes. */
export function visibleWidth(s: string): number {
  return stripAnsi(s).length;
}

/** Right-pad a colored string to `width` visible columns. */
export function pad(s: string, width: number): string {
  const extra = Math.max(0, width - visibleWidth(s));
  return s + ' '.repeat(extra);
}

/** Status helpers. */
export const status = {
  info: (msg: string) => `  ${C.cyan}▸${C.reset}  ${msg}`,
  ok: (msg: string) => `  ${C.green}✓${C.reset}  ${msg}`,
  warn: (msg: string) => `  ${C.yellow}!${C.reset}  ${C.yellow}${msg}${C.reset}`,
  err: (msg: string) => `  ${C.red}✗${C.reset}  ${C.red}${msg}${C.reset}`,
} as const;

/** Faded horizontal rule. */
export function rule(width = 56): string {
  return `  ${C.faded}${'─'.repeat(width)}${C.reset}`;
}

/** "  Kortix CLI  v0.1.0" header style. */
export function header(title: string, version: string): string {
  return `  ${C.white}${C.bold}${title}${C.reset}  ${C.faded}v${version}${C.reset}`;
}

// ── Help text formatting ────────────────────────────────────────────────────
// Subcommand help is authored as a plain `Usage: …` block; `formatHelp` gives
// it the same visual language as the root `kortix` help (styled title + rule,
// bold-white section headers, dim descriptions, faded <args>/[opts], cyan
// `code`) without the author having to hand-style anything. Text is preserved
// line-for-line — only ANSI color and a title rule are added — so it degrades
// cleanly to the original plain text under NO_COLOR / non-TTY.

/** Colorize inline `code` (cyan) and <args>/[opts] (faded) within a segment,
 *  resuming `resume` after each span so a surrounding style (e.g. dim) holds. */
function inlineSpans(s: string, resume: string): string {
  return s
    .replace(/([<[][^<>[\]]*[>\]])/g, `${C.faded}$1${resume}`)
    .replace(/`([^`]+)`/g, `${C.cyan}$1${resume}`);
}

export function formatHelp(raw: string): string {
  const lines = raw.replace(/\s+$/, '').split('\n');
  const out: string[] = [''];
  let sawUsage = false;

  for (const line of lines) {
    // First `Usage: kortix …` line → styled title (bold command, faded args)
    // followed by a rule, mirroring the root help's header.
    if (!sawUsage) {
      const usage = line.match(/^Usage:\s+(.*)$/);
      if (usage) {
        const inv = usage[1];
        const brk = inv.search(/[<[]/);
        const path = (brk === -1 ? inv : inv.slice(0, brk)).trimEnd();
        const args = brk === -1 ? '' : inv.slice(brk).trim();
        const argsPart = args ? ` ${C.faded}${args}${C.reset}` : '';
        out.push(`  ${C.dim}Usage:${C.reset} ${C.white}${C.bold}${path}${C.reset}${argsPart}`);
        out.push(rule());
        sawUsage = true;
        continue;
      }
    }

    if (line.trim() === '') {
      out.push('');
      continue;
    }

    // Section header: flush-left, ends in ':', short and plain (no code, em-dash
    // or '='), e.g. "Subcommands:", "Global options:", "Add options (…):".
    if (
      !/^\s/.test(line) &&
      /:$/.test(line) &&
      visibleWidth(line) <= 40 &&
      !line.includes('`') &&
      !line.includes(' — ') &&
      !line.includes('=')
    ) {
      out.push('');
      out.push(`  ${C.white}${C.bold}${line.slice(0, -1)}${C.reset}${C.dim}:${C.reset}`);
      continue;
    }

    // Two-column row: indent + term + 2-space gap + description.
    const row = line.match(/^(\s+)(\S.*?)(\s{2,})(\S.*)$/);
    if (row) {
      const [, lead, term, gap, desc] = row;
      out.push(
        `${lead}${inlineSpans(term, C.reset)}${gap}${C.dim}${inlineSpans(desc, C.dim)}${C.reset}`,
      );
      continue;
    }

    // Deeply-indented continuation of a wrapped description → dim, in place.
    const cont = line.match(/^(\s{4,})(\S.*)$/);
    if (cont) {
      out.push(`${cont[1]}${C.dim}${inlineSpans(cont[2], C.dim)}${C.reset}`);
      continue;
    }

    // Everything else is prose. A flush-left paragraph gets the 2-space base so
    // it sits under the section headers; a line the author already indented (a
    // list item, a numbered step, a sub-bullet) keeps its own indent so it
    // stays aligned with sibling rows instead of being pushed out by a second.
    const body = line.trimStart();
    const lead = line.slice(0, line.length - body.length);
    out.push(`${lead || '  '}${inlineSpans(body, C.reset)}`);
  }

  out.push('');
  // Collapse runs of blank lines (authored blanks + the ones we insert before
  // headers can double up) so spacing stays even.
  const collapsed = out.filter((line, i) => !(line === '' && out[i - 1] === ''));
  return `${collapsed.join('\n')}\n`;
}

/** Tagged-template wrapper so a command can write `const HELP = help\`Usage: …\``
 *  and get `formatHelp` styling with a one-token change and no content edits. */
export function help(strings: TemplateStringsArray, ...values: unknown[]): string {
  let raw = strings[0] ?? '';
  for (let i = 0; i < values.length; i++) raw += String(values[i]) + (strings[i + 1] ?? '');
  return formatHelp(raw);
}
