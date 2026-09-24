/**
 * Pure logic of the PTY tool rows — a port of apps/web
 * `tool/tools/pty-spawn-tool.tsx`, `pty-read-tool.tsx` (`splitTerminalBuffer`
 * and its parse), `pty-write-tool.tsx`, `pty-kill-tool.tsx`, and
 * `tool/tool-renderers-sanitization.ts` `stripMarkupForToolOutput`.
 */

import { stripAnsi } from '@kortix/sdk';

/** apps/web en strings the four rows use. */
export const PTY_TEXT = {
  /** `i18nComplete.textea51081eb280` */
  startedTerminal: 'Started terminal',
  /** `componentsSessionToolRenderers.line2624JsxTextTerminalOutput` */
  terminalOutput: 'Terminal output',
  /** `i18nComplete.text32822e8808cc` */
  terminalInput: 'Terminal input',
  /** `componentsSessionToolRenderers.line2685JsxTextText` */
  inputPrompt: '>',
  /** `i18nComplete.text6336bd6d9945` */
  stoppedProcess: 'Stopped process',
} as const;

/** `i18nComplete.textffffeef5ea06` — "{value0} earlier lines". */
export function earlierLinesLabel(count: number): string {
  return `${count} earlier lines`;
}

// ─── pty_spawn ───────────────────────────────────────────────────────────────

export interface PtySpawnView {
  title: string;
  command: string;
  processStatus: string;
  pid: string;
  ptyId: string;
  workdir: string;
  /** The row's subtitle: the model's title, else the command. */
  subtitle: string;
  /** Only when the subtitle IS the command — the open card prints it under `$`. */
  hideSubtitleWhenOpen: boolean;
  hasMeta: boolean;
}

function parsePtySpawned(output: string): Record<string, string> | null {
  const match = output.match(/<pty_spawned>([\s\S]*?)<\/pty_spawned>/);
  if (!match) return null;
  const fields: Record<string, string> = {};
  for (const line of match[1].trim().split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx > 0) fields[line.slice(0, colonIdx).trim()] = line.slice(colonIdx + 1).trim();
  }
  return fields;
}

export function ptySpawnView(input: Record<string, unknown>, output: string): PtySpawnView {
  const parsed = parsePtySpawned(output);
  const title = parsed?.Title || (input.title as string) || '';
  const command = parsed?.Command || (input.command as string) || '';
  const processStatus = parsed?.Status || '';
  const pid = parsed?.PID || '';
  const ptyId = parsed?.ID || '';
  const workdir = parsed?.Workdir || '';
  return {
    title,
    command,
    processStatus,
    pid,
    ptyId,
    workdir,
    subtitle: title || command,
    hideSubtitleWhenOpen: !title,
    hasMeta: Boolean(processStatus || ptyId || pid || workdir),
  };
}

// ─── pty_read ────────────────────────────────────────────────────────────────

/** 24 lines — the classic terminal height; the rest folds. */
export const VISIBLE_TAIL_LINES = 24;

export function splitTerminalBuffer(content: string): { earlier: string; tail: string; earlierCount: number } {
  const lines = content ? content.split('\n') : [];
  if (lines.length <= VISIBLE_TAIL_LINES) return { earlier: '', tail: content, earlierCount: 0 };
  const cut = lines.length - VISIBLE_TAIL_LINES;
  return { earlier: lines.slice(0, cut).join('\n'), tail: lines.slice(cut).join('\n'), earlierCount: cut };
}

export interface PtyReadView {
  id: string;
  ptyStatus: string;
  content: string;
  bufferInfo: string;
  buffer: ReturnType<typeof splitTerminalBuffer>;
}

export function parsePtyReadOutput(output: string): PtyReadView {
  const match = output.match(/<pty_output\s+([^>]*)>([\s\S]*?)<\/pty_output>/);
  if (!match) {
    const content = stripAnsi(output);
    return { id: '', ptyStatus: '', content, bufferInfo: '', buffer: splitTerminalBuffer(content) };
  }
  const attrs = match[1];
  const idMatch = attrs.match(/id="([^"]+)"/);
  const statusMatch = attrs.match(/status="([^"]+)"/);
  const contentLines: string[] = [];
  let bufferInfo = '';
  for (const line of match[2].trim().split('\n')) {
    if (/^\(End of buffer/.test(line.trim())) {
      bufferInfo = line.trim();
      continue;
    }
    contentLines.push(line.replace(/^\d{5}\|\s?/, ''));
  }
  const content = stripAnsi(contentLines.join('\n').trim());
  return {
    id: idMatch?.[1] || '',
    ptyStatus: statusMatch?.[1] || '',
    content,
    bufferInfo,
    buffer: splitTerminalBuffer(content),
  };
}

// ─── pty_write / pty_kill ────────────────────────────────────────────────────

export function ptyWriteView(input: Record<string, unknown>): { ptyInput: string; ptyId: string } {
  return {
    ptyInput: (input.input as string) || (input.text as string) || '',
    ptyId: (input.id as string) || (input.pty_id as string) || '',
  };
}

export function ptyKillId(input: Record<string, unknown>): string {
  return (input.id as string) || (input.pty_id as string) || '';
}

// ─── stripMarkupForToolOutput ────────────────────────────────────────────────

function findTagCloseIndex(input: string, tagStart: number): number {
  let quote: '"' | "'" | undefined;
  for (let index = tagStart + 1; index < input.length; index += 1) {
    const char = input[index];
    if (quote) {
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '>') return index;
  }
  return -1;
}

function isWhitespace(char: string): boolean {
  return char === ' ' || char === '\t' || char === '\n' || char === '\r' || char === '\f' || char === '\v';
}

/** Web `stripMarkupForToolOutput`: drop comments and tags (linear, quote-aware), collapse whitespace. */
export function stripMarkupForToolOutput(output: string): string {
  let text = '';
  let index = 0;
  while (index < output.length) {
    if (output.startsWith('<!--', index)) {
      const commentEnd = output.indexOf('-->', index + 4);
      index = commentEnd === -1 ? output.length : commentEnd + 3;
      continue;
    }
    if (output[index] !== '<') {
      text += output[index];
      index += 1;
      continue;
    }
    const tagEnd = findTagCloseIndex(output, index);
    if (tagEnd === -1) break;
    index = tagEnd + 1;
  }

  let normalized = '';
  let pendingSpace = false;
  for (const char of text) {
    if (isWhitespace(char)) {
      pendingSpace = normalized.length > 0;
      continue;
    }
    if (pendingSpace) {
      normalized += ' ';
      pendingSpace = false;
    }
    normalized += char;
  }
  return normalized.trim();
}
