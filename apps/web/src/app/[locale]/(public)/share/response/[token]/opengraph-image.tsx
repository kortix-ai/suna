import { ImageResponse } from 'next/og';

import { getTranslations } from '@/i18n/get-translations';

import { loadPublicResponse } from './public-response';

// The share card template (kortix-brand art-direction.md, "OG and share cards"):
// the symbol, the page title, black on white, light only, 1200 x 630.
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';
export const alt = 'Kortix';

// Satori cannot read CSS variables, so the two light-theme roles are inlined
// from tokens.css (--background, --foreground).
const BACKGROUND = '#ffffff'; // audit:allow tokens.css --background (light): Satori reads no CSS variables
const FOREGROUND = '#1f1f1f'; // audit:allow tokens.css --foreground (light): Satori reads no CSS variables

// Spacing step 16 at --spacing 0.23rem: 16 * 3.68px.
const MARGIN = 59;
// The nav logo height (components/home/navbar.tsx renders the logo at size 15).
const SYMBOL_HEIGHT = 15;
// The master symbol, `apps/web/public/brandkit/Logo/Brandmark/SVG/Brandmark Black.svg`.
const SYMBOL_VIEWBOX = { width: 164, height: 140 };
const SYMBOL_PATH =
  'M139.737 139.53H163.055C163.055 109.932 147.261 84.0225 123.642 69.7694C147.261 55.5163 163.054 29.6068 163.054 0.0085907H139.736C139.736 28.0165 119.67 51.4471 93.2922 56.9406V0.0085907H69.9773V56.9406C43.4754 51.5428 23.5331 28.1045 23.5331 0.0085907H0.21529C0.21529 29.6068 16.0088 55.5163 39.6282 69.7694C16.0086 84.0225 0.214773 109.932 0.214773 139.53H23.5325C23.5325 111.434 43.4754 87.996 69.9773 82.5981V139.556H93.2922V82.598C119.794 87.9957 139.737 111.434 139.737 139.53Z';

export default async function Image({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const t = await getTranslations('turnShare');
  // A revoked or unknown token still unfurls: the generic title, never the text.
  const result = await loadPublicResponse(token).catch(() => null);
  const title =
    result?.kind === 'shared' && result.response.title ? result.response.title : t('fallbackTitle');

  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          padding: MARGIN,
          background: BACKGROUND,
          color: FOREGROUND,
        }}
      >
        <svg
          width={(SYMBOL_HEIGHT * SYMBOL_VIEWBOX.width) / SYMBOL_VIEWBOX.height}
          height={SYMBOL_HEIGHT}
          viewBox={`0 0 ${SYMBOL_VIEWBOX.width} ${SYMBOL_VIEWBOX.height}`}
        >
          <path d={SYMBOL_PATH} fill={FOREGROUND} />
        </svg>
        <div
          style={{
            display: 'block',
            fontSize: 72,
            fontWeight: 600,
            lineHeight: 1.15,
            letterSpacing: '-0.025em',
            lineClamp: 3,
          }}
        >
          {title}
        </div>
      </div>
    ),
    size,
  );
}
