import { getServerPublicEnv } from '@/lib/public-env-server';
import { getPublicTemplate } from '@kortix/sdk';
import { ImageResponse } from 'next/og';
import type { NextRequest } from 'next/server';

import { OgFallbackCard, type PublicTemplateOgData, TemplateOgCard } from './og-cards';

// Node, not Edge. This route is a social-preview image: low traffic, no
// latency budget. As an Edge Function it carried the whole `@kortix/sdk`
// barrel plus, from 2026-09-07 (#7160), the 638 KB `translations/en.json`
// behind `getHardcodedUiServerText` — 5.51 MB against Vercel's 4.02 MB Edge
// Function limit, which failed the staging frontend deploy for release
// 0.13.12. The Node runtime has no such gate, and the four strings this
// image renders are English constants, not localized copy (`OG_TEXT` lives
// beside the cards in og-cards.tsx).
export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  try {
    const runtimeEnv = getServerPublicEnv();
    const { searchParams } = new URL(request.url);
    const shareId = searchParams.get('shareId');

    if (!shareId) {
      return new Response('Invalid shareId parameter', { status: 400 });
    }

    const template = await getPublicTemplate<PublicTemplateOgData>(
      runtimeEnv.BACKEND_URL,
      shareId,
      AbortSignal.timeout(5000),
    );
    return new ImageResponse(<TemplateOgCard template={template} />, {
      width: 1200,
      height: 630,
    });
  } catch (error) {
    console.error('OG Image generation error:', error);
    return new ImageResponse(<OgFallbackCard />, {
      width: 1200,
      height: 630,
    });
  }
}
