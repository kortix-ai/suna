/**
 * The KORTIX splash: the block-letter wordmark in the terminal accent, with a
 * few `label value` lines under it.
 *
 * Shown while the TUI boots (`features/boot`) and at the head of an empty
 * session, the way a fresh shell prints its banner. Brand decision D31
 * sanctions the wordmark here, in `terminal-accent` (`theme.brand`), and the
 * art itself is the one copy the CLI banner prints too
 * (`@kortix/shared/wordmark`).
 *
 * Below `KORTIX_WORDMARK_WIDTH + 4` columns the art cannot fit, so the splash
 * falls back to the word `kortix` in the accent: a wordmark cut in half reads
 * as a rendering bug.
 */

import { KORTIX_WORDMARK, KORTIX_WORDMARK_WIDTH } from '@kortix/shared/wordmark';

import { theme } from '../theme.ts';

export interface SplashLine {
  label: string;
  value: string;
}

export interface SplashProps {
  width: number;
  /** One dim line under the wordmark: what this is. */
  tagline?: string;
  lines?: readonly SplashLine[];
  /** Center the block horizontally (the boot screen). Default: left, 2-col indent. */
  center?: boolean;
}

/** Rows the splash draws for `lineCount` metadata lines at `width`. */
export function splashHeight(width: number, lineCount: number, tagline = true): number {
  const art = width >= KORTIX_WORDMARK_WIDTH + 4 ? KORTIX_WORDMARK.length : 1;
  return art + (tagline ? 2 : 1) + lineCount;
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function Splash({ width, tagline, lines = [], center = false }: SplashProps) {
  const fits = width >= KORTIX_WORDMARK_WIDTH + 4;
  const labelWidth = Math.max(...lines.map((line) => line.label.length), 0) + 1;
  const blockWidth = Math.min(Math.max(KORTIX_WORDMARK_WIDTH, 40), width - 2);
  const indent = center ? Math.max(Math.floor((width - blockWidth) / 2), 0) : 2;
  const valueWidth = Math.max(blockWidth - labelWidth, 8);

  return (
    <box flexDirection="column" paddingLeft={indent} flexShrink={0}>
      {fits ? (
        KORTIX_WORDMARK.map((row) => (
          <text key={row} fg={theme.brand} wrapMode="none" height={1}>
            {row}
          </text>
        ))
      ) : (
        <text fg={theme.brand} wrapMode="none" height={1}>
          kortix
        </text>
      )}
      {tagline ? (
        <text fg={theme.dim} wrapMode="none" height={1} marginTop={1}>
          {clip(tagline, Math.max(width - indent - 1, 8))}
        </text>
      ) : (
        <box height={1} />
      )}
      {lines.map((line) => (
        <text key={line.label} wrapMode="none" height={1}>
          <span fg={theme.faint}>{line.label.padEnd(labelWidth)}</span>
          <span fg={theme.dim}>
            {line.value.length > valueWidth ? `${line.value.slice(0, valueWidth - 1)}…` : line.value}
          </span>
        </text>
      ))}
    </box>
  );
}
