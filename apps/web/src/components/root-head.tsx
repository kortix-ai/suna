import { DESKTOP_INIT_SCRIPT } from '@/lib/desktop';
import type { getServerPublicEnv } from '@/lib/public-env-server';
import { safeJsonForHtml } from '@/lib/security/safe-json';
import { siteMetadata } from '@/lib/site-metadata';
import { featureFlags } from '@kortix/sdk';

/**
 * The root layout's static <head> payloads, moved verbatim from
 * `app/[locale]/layout.tsx`. The order is load-bearing — the runtime-config
 * boot script must precede everything that reads it, the desktop detection
 * script must run before first paint, and GTM's dataLayer context must
 * initialize before the GTM container loads — and is pinned by
 * `app/[locale]/layout-head-order.test.ts`.
 */
export function RootHead({
  runtimeEnv,
}: {
  runtimeEnv: ReturnType<typeof getServerPublicEnv>;
}) {
  return (
    <>
      {/* Runtime config. Standalone/Docker: evaluated per request via
          connection() in the layout, so images pick up container env vars.
          Vercel: baked at build from the same environment. */}
      <script
        // biome-ignore lint/security/noDangerouslySetInnerHtml: static, server-controlled boot scripts moved verbatim from the root layout
        dangerouslySetInnerHTML={{
          __html: `window.__KORTIX_RUNTIME_CONFIG=${safeJsonForHtml(runtimeEnv)};window.__RUNTIME_ENV=window.__KORTIX_RUNTIME_CONFIG;`,
        }}
      />

      {/* Desktop runtime detection — runs before hydration so CSS reacts on first paint. */}
      <script
        // biome-ignore lint/security/noDangerouslySetInnerHtml: static, server-controlled boot scripts moved verbatim from the root layout
        dangerouslySetInnerHTML={{ __html: DESKTOP_INIT_SCRIPT }}
      />

      {/* Font preloading is handled automatically by next/font/local in fonts/roobert.ts */}

      {/* Prevent browser auto-translate (Google Translate, Chrome, etc.) from
          mutating the DOM. When translators modify text nodes, React's reconciler
          crashes with "Failed to execute 'insertBefore' on 'Node'".
          The app ships its own i18n via next-intl (en, de, it, zh, ja, pt, fr, es, sr)
          so browser translation is unnecessary and actively harmful. */}
      <meta name="google" content="notranslate" />

      {/* DNS prefetch for analytics (loaded later but resolve DNS early) */}
      <link rel="dns-prefetch" href="https://www.googletagmanager.com" />
      <link rel="dns-prefetch" href="https://eu.i.posthog.com" />

      {/* Container Load - Initialize dataLayer with page context BEFORE GTM loads */}
      <script
        // biome-ignore lint/security/noDangerouslySetInnerHtml: static, server-controlled boot scripts moved verbatim from the root layout
        dangerouslySetInnerHTML={{
          __html: `
              (function() {
                window.dataLayer = window.dataLayer || [];
                var pathname = window.location.pathname;
                var pathParts = pathname.split('/');
                if (pathParts.length >= 3 && pathParts[1] === 'instances') {
                  pathname = '/' + pathParts.slice(3).join('/');
                  if (pathname === '/') {
                    pathname = '/';
                  } else if (!pathname.startsWith('/')) {
                    pathname = '/' + pathname;
                  }
                }

                // Default analytics language to English. UI language changes only
                // after an explicit profile settings update; browser storage and
                // cookies must not infer language.
                var lang = 'en';

                var context = { master_group: 'General', content_group: 'Other', page_type: 'other', language: lang };

                if (pathname === '/' || pathname === '') {
                  context = { master_group: 'General', content_group: 'Other', page_type: 'home', language: lang };
                } else if (pathname.indexOf('/auth') === 0) {
                  context = { master_group: 'General', content_group: 'User', page_type: 'auth', language: lang };
                } else if (pathname.indexOf('/workspace') === 0 || pathname.indexOf('/projects') === 0 || pathname.indexOf('/thread') === 0) {
                  context = { master_group: 'Platform', content_group: 'Projects', page_type: 'thread', language: lang };
                } else if (pathname.indexOf('/settings') === 0) {
                  context = { master_group: 'Platform', content_group: 'User', page_type: 'settings', language: lang };
                }

                window.dataLayer.push(context);
              })();
            `,
        }}
      />

      {/* iOS Smart App Banner - shows native install banner in Safari */}
      {!featureFlags.disableMobileAdvertising ? (
        <meta name="apple-itunes-app" content={'app-id=6754448524, app-argument=kortix://'} />
      ) : null}

      <script
        type="application/ld+json"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: static, server-controlled boot scripts moved verbatim from the root layout
        dangerouslySetInnerHTML={{
          __html: safeJsonForHtml({
            '@context': 'https://schema.org',
            '@type': 'Organization',
            name: siteMetadata.name,
            alternateName: ['Kortix', 'Kortix AI', 'Kortix – The open-source AI Management System'],
            url: siteMetadata.url,
            logo: `${siteMetadata.url}/favicon.svg`,
            description: siteMetadata.description,
            foundingDate: '2024',
            sameAs: [
              'https://github.com/kortix-ai/suna',
              'https://x.com/kortix',
              'https://linkedin.com/company/kortix',
            ],
            contactPoint: {
              '@type': 'ContactPoint',
              contactType: 'Customer Support',
              url: siteMetadata.url,
            },
          }),
        }}
      />

      <script
        type="application/ld+json"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: static, server-controlled boot scripts moved verbatim from the root layout
        dangerouslySetInnerHTML={{
          __html: safeJsonForHtml({
            '@context': 'https://schema.org',
            '@type': 'SoftwareApplication',
            name: siteMetadata.title,
            alternateName: [siteMetadata.name, 'Kortix'],
            applicationCategory: 'BusinessApplication',
            operatingSystem: 'Web, macOS, Windows, Linux',
            description: siteMetadata.description,
            offers: {
              '@type': 'Offer',
              price: '0',
              priceCurrency: 'USD',
            },
          }),
        }}
      />
    </>
  );
}
