const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const CYAN = '\x1b[0;36m';
const WHITE = '\x1b[1;37m';
const FADED = '\x1b[2;37m';

const ART = [
  '   ██╗  ██╗ ██████╗ ██████╗ ████████╗██╗██╗  ██╗',
  '   ██║ ██╔╝██╔═══██╗██╔══██╗╚══██╔══╝██║╚██╗██╔╝',
  '   █████╔╝ ██║   ██║██████╔╝   ██║   ██║ ╚███╔╝ ',
  '   ██╔═██╗ ██║   ██║██╔══██╗   ██║   ██║ ██╔██╗ ',
  '   ██║  ██╗╚██████╔╝██║  ██║   ██║   ██║██╔╝ ██╗',
  '   ╚═╝  ╚═╝ ╚═════╝ ╚═╝  ╚═╝   ╚═╝   ╚═╝╚═╝  ╚═╝',
];

const TAGLINE = 'The open-source AI Management System';

function colorize(s: string): string {
  return process.stdout.isTTY === true ? s : stripAnsi(s);
}

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

export function printBanner(): void {
  const lines: string[] = ['', ''];
  for (const row of ART) lines.push(`${CYAN}${row}${RESET}`);
  lines.push('');
  lines.push(`   ${WHITE}${TAGLINE}${RESET}   ${FADED}·  configure your Kortix project${RESET}`);
  lines.push('');
  process.stdout.write(colorize(lines.join('\n')) + '\n');
}

/** Width of the inner content area inside the get-started box. */
const BOX_WIDTH = 70;

function pad(s: string, width: number): string {
  const visible = stripAnsi(s);
  const extra = Math.max(0, width - visible.length);
  return s + ' '.repeat(extra);
}

function boxLine(content: string): string {
  return `${FADED}║${RESET} ${pad(content, BOX_WIDTH)} ${FADED}║${RESET}`;
}

function boxTop(title: string): string {
  const inner = ` ${title} `;
  const fill = '═'.repeat(Math.max(0, BOX_WIDTH + 2 - inner.length));
  const half = Math.floor(fill.length / 2);
  return `${FADED}╔${'═'.repeat(half)}${RESET}${BOLD}${inner}${RESET}${FADED}${'═'.repeat(fill.length - half)}╗${RESET}`;
}

function boxBottom(): string {
  return `${FADED}╚${'═'.repeat(BOX_WIDTH + 2)}╝${RESET}`;
}

/** Nested inset card for the "ask <agent>" panel. Spans the full
 * content area of the outer box so the right edges align. */
function insetCard(title: string, body: string[]): string[] {
  const innerWidth = BOX_WIDTH;
  const titleStr = ` ${title} `;
  const fill = '─'.repeat(Math.max(0, innerWidth - 2 - titleStr.length));
  const half = Math.floor(fill.length / 2);
  const out: string[] = [];
  out.push(
    boxLine(
      `${FADED}╭${'─'.repeat(half)}${RESET}${DIM}${titleStr}${RESET}${FADED}${'─'.repeat(fill.length - half)}╮${RESET}`,
    ),
  );
  for (const line of body) {
    const padded = pad(line, innerWidth - 4);
    out.push(boxLine(`${FADED}│${RESET} ${padded} ${FADED}│${RESET}`));
  }
  out.push(boxLine(`${FADED}╰${'─'.repeat(innerWidth - 2)}╯${RESET}`));
  return out;
}

/** Wrap plain text to a max width, returning lines. */
function wrap(text: string, width: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    if ((cur + (cur ? ' ' : '') + w).length > width) {
      if (cur) lines.push(cur);
      cur = w;
    } else {
      cur = cur ? `${cur} ${w}` : w;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

export interface GetStartedInput {
  prompt: string;
}

export function printGetStarted({ prompt }: GetStartedInput): void {
  const lines: string[] = [''];
  lines.push(boxTop('get started'));
  lines.push(boxLine(''));
  lines.push(
    boxLine(`${DIM}Paste this prompt into your ${RESET}${BOLD}coding agent of choice${RESET}`),
  );
  lines.push(boxLine(`${DIM}to configure your Kortix project:${RESET}`));
  lines.push(boxLine(''));

  const innerInsetWidth = BOX_WIDTH - 4;
  const wrapped = wrap(prompt, innerInsetWidth);
  for (const line of insetCard('prompt', wrapped)) lines.push(line);

  lines.push(boxLine(''));
  lines.push(
    boxLine(`${DIM}When you're ready, take it live:${RESET}  ${CYAN}kortix ship${RESET}`),
  );
  lines.push(
    boxLine(`${DIM}links your GitHub repo (1-click) + sets your env — no web UI${RESET}`),
  );
  lines.push(boxLine(''));
  lines.push(boxBottom());
  lines.push('');
  process.stdout.write(colorize(lines.join('\n')) + '\n');
}
