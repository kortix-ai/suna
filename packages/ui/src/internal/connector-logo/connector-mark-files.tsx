import { renderToStaticMarkup } from 'react-dom/server';

import { NATIVE_MARK } from './connector-logo';
import type { NativeConnectorApp } from './connector-logo-source';

/** `MarkTile`'s look, as a file: white ground, hairline border, rounded corners. */
const TILE_FILL = '#FFFFFF';
const TILE_BORDER = '#E4E4E7';
/** `text-muted-foreground` on the light ground, for the glyph marks. */
const GLYPH_COLOR = '#71717A';

const LABEL: Record<NativeConnectorApp, string> = {
  slack: 'Slack',
  teams: 'Microsoft Teams',
  telegram: 'Telegram',
  email: 'Email',
  computer: 'Computer',
};

/**
 * The SVG file for a Kortix-built connector's logo
 * (`apps/web/public/connector-icons/<app>.svg`): its `ConnectorLogo` mark on
 * the tile, rendered from the same component. Written by
 * `scripts/write-connector-marks.tsx`; `connector-mark-files.test.ts` fails
 * when a committed file and this output differ.
 */
export function nativeMarkFileSvg(app: NativeConnectorApp): string {
  const { Mark, brand } = NATIVE_MARK[app];
  const markup = renderToStaticMarkup(<Mark />);
  const open = markup.slice(0, markup.indexOf('>'));
  // The mark's own size and class give way to its place on the tile.
  const placed = open.replace(/ (?:class|width|height)="[^"]*"/g, '').replace(/^<svg/, '<svg x="8" y="8" width="20" height="20"');
  const mark = (placed + markup.slice(open.length))
    .replaceAll('currentColor', brand ? 'currentColor' : GLYPH_COLOR);
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 36 36" role="img" aria-label="${LABEL[app]}">` +
    `<rect x="0.5" y="0.5" width="35" height="35" rx="7.5" fill="${TILE_FILL}" stroke="${TILE_BORDER}"/>` +
    `${mark}</svg>\n`
  );
}

export const NATIVE_MARK_APPS = Object.keys(LABEL) as NativeConnectorApp[];
