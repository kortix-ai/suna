import { C, pad } from './style';

const ART = [
  '   ██╗  ██╗ ██████╗ ██████╗ ████████╗██╗██╗  ██╗',
  '   ██║ ██╔╝██╔═══██╗██╔══██╗╚══██╔══╝██║╚██╗██╔╝',
  '   █████╔╝ ██║   ██║██████╔╝   ██║   ██║ ╚███╔╝ ',
  '   ██╔═██╗ ██║   ██║██╔══██╗   ██║   ██║ ██╔██╗ ',
  '   ██║  ██╗╚██████╔╝██║  ██║   ██║   ██║██╔╝ ██╗',
  '   ╚═╝  ╚═╝ ╚═════╝ ╚═╝  ╚═╝   ╚═╝   ╚═╝╚═╝  ╚═╝',
];

const TAGLINE = 'The open-source AI Management System';

export function printBanner(): void {
  const lines: string[] = ['', ''];
  for (const row of ART) lines.push(`${C.cyan}${row}${C.reset}`);
  lines.push('');
  lines.push(`   ${C.white}${TAGLINE}${C.reset}   ${C.faded}·  configure your Kortix project${C.reset}`);
  lines.push('');
  process.stdout.write(lines.join('\n') + '\n');
}

/** Width of the inner content area inside the get-started box. */
const BOX_WIDTH = 70;

function boxLine(content: string): string {
  return `${C.faded}║${C.reset} ${pad(content, BOX_WIDTH)} ${C.faded}║${C.reset}`;
}

function boxTop(title: string): string {
  const inner = ` ${title} `;
  const fill = '═'.repeat(Math.max(0, BOX_WIDTH + 2 - inner.length));
  const half = Math.floor(fill.length / 2);
  return `${C.faded}╔${'═'.repeat(half)}${C.reset}${C.bold}${inner}${C.reset}${C.faded}${'═'.repeat(fill.length - half)}╗${C.reset}`;
}

function boxBottom(): string {
  return `${C.faded}╚${'═'.repeat(BOX_WIDTH + 2)}╝${C.reset}`;
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
      `${C.faded}╭${'─'.repeat(half)}${C.reset}${C.dim}${titleStr}${C.reset}${C.faded}${'─'.repeat(fill.length - half)}╮${C.reset}`,
    ),
  );
  for (const line of body) {
    const padded = pad(line, innerWidth - 4);
    out.push(boxLine(`${C.faded}│${C.reset} ${padded} ${C.faded}│${C.reset}`));
  }
  out.push(boxLine(`${C.faded}╰${'─'.repeat(innerWidth - 2)}╯${C.reset}`));
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
    boxLine(`${C.dim}Paste this prompt into your ${C.reset}${C.bold}coding agent of choice${C.reset}`),
  );
  lines.push(boxLine(`${C.dim}to configure your Kortix project:${C.reset}`));
  lines.push(boxLine(''));

  const innerInsetWidth = BOX_WIDTH - 4;
  const wrapped = wrap(prompt, innerInsetWidth);
  for (const line of insetCard('prompt', wrapped)) lines.push(line);

  lines.push(boxLine(''));
  lines.push(
    boxLine(`${C.dim}When you're ready, take it live:${C.reset}  ${C.cyan}kortix ship${C.reset}`),
  );
  lines.push(
    boxLine(`${C.dim}links your GitHub repo (1-click) + sets your env — no web UI${C.reset}`),
  );
  lines.push(boxLine(''));
  lines.push(boxBottom());
  lines.push('');
  process.stdout.write(lines.join('\n') + '\n');
}
