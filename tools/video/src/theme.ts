import { staticFile } from 'remotion';

/**
 * Kortix brand constants for the marketing videos.
 *
 * Mirrors globals.css: black and white with one accent, Roobert for text and
 * Roobert Mono for anything that represents code or config.
 */
export const FPS = 30;
export const WIDTH = 1920;
export const HEIGHT = 1080;

export const color = {
  ink: '#0a0a0a',
  paper: '#fafafa',
  muted: '#71717a',
  hairline: '#e4e4e7',
  green: '#3ecf8e',
  orange: '#ff7043',
} as const;

export const font = {
  sans: 'Roobert',
  mono: 'RoobertMono',
} as const;

/** Injected once at the root so every scene shares the brand faces. */
export const FONT_CSS = `
@font-face {
  font-family: 'Roobert';
  src: url('${staticFile('fonts/RoobertUprightsVF.woff2')}') format('woff2-variations');
  font-weight: 100 900;
  font-style: normal;
}
@font-face {
  font-family: 'RoobertMono';
  src: url('${staticFile('fonts/RoobertMonoUprightsVF.woff2')}') format('woff2-variations');
  font-weight: 100 900;
  font-style: normal;
}
`;

/** Shared easing — matches the springy-but-never-bouncy feel of the UI. */
export const EASE = [0.22, 1, 0.36, 1] as const;
