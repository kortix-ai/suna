'use client';

import { useEffect } from 'react';

/**
 * Cookie consent component
 *
 * The CMP script/widget is not owned by the app code in some environments
 * (e.g. injected via GTM, hosting provider, or legacy snippets). To ensure it
 * cannot break core UI interactions (capturing clicks / stuck overlays), we
 * aggressively remove known cookie-consent artifacts from the DOM.
 */
export function CookieConsent() {
  useEffect(() => {
    const SELECTORS: string[] = [
      // CookieYes (CKY)
      '.cky-consent-container',
      '.cky-consent-bar',
      '.cky-overlay',
      '.cky-modal',
      '.cky-btn-revisit-wrapper',
      '.cky-btn-revisit',
      '#cky-consent-container',
      '#cky-consent-bar',
      '#cky-overlay',
      '#cky-btn-revisit-wrapper',

      // OneTrust
      '#onetrust-consent-sdk',
      '#onetrust-banner-sdk',
      '#ot-sdk-btn',
      '.ot-sdk-container',
      '.ot-sdk-row',

      // Cookiebot
      '#CybotCookiebotDialog',
      '#CybotCookiebotDialogBodyUnderlay',
      '#CookiebotWidget',
      '#CookiebotBanner',

      // Osano
      '.osano-cm-widget',
      '.osano-cm-dialog',
      '.osano-cm-window',
      '.osano-cm-overlay',

      // Iubenda
      '.iubenda-cs-container',
      '.iubenda-cs-overlay',

      // Quantcast
      '#qc-cmp2-ui',
      '.qc-cmp2-container',
    ];

    const SRC_MATCHERS = [
      // CookieYes / CookieLawInfo
      'cdn-cookieyes.com',
      'cookieyes.com',
      'cookie-law-info',
      // OneTrust (common CDN host)
      'cookielaw.org',
      // OneTrust
      'onetrust',
      'optanon',
      // Cookiebot
      'cookiebot',
      'cybot',
      // Osano
      'osano',
      // Iubenda
      'iubenda',
      // Quantcast
      'quantcast',
      'qc-cmp',
    ];

    const matchesKnownCmpSrc = (src: string) => {
      const s = src.toLowerCase();
      return SRC_MATCHERS.some(m => s.includes(m));
    };

    const removeArtifacts = () => {
      const removedSelectors: Array<{ selector: string; count: number }> = [];

      for (const selector of SELECTORS) {
        const nodes = Array.from(document.querySelectorAll(selector));
        if (nodes.length > 0) {
          for (const node of nodes) node.remove();
          removedSelectors.push({ selector, count: nodes.length });
        }
      }

      const removedScripts = Array.from(document.querySelectorAll('script[src]'))
        .filter(script => matchesKnownCmpSrc(script.getAttribute('src') ?? ''))
        .map(script => {
          const src = script.getAttribute('src') ?? '';
          script.remove();
          return src;
        });

      const removedIframes = Array.from(document.querySelectorAll('iframe[src]'))
        .filter(iframe => matchesKnownCmpSrc(iframe.getAttribute('src') ?? ''))
        .map(iframe => {
          const src = iframe.getAttribute('src') ?? '';
          iframe.remove();
          return src;
        });

      // Some CMPs inject inline <style> tags; only remove those that mention known CMP keywords.
      const removedStyles = Array.from(document.querySelectorAll('style'))
        .filter(styleEl => matchesKnownCmpSrc(styleEl.textContent ?? ''))
        .map(styleEl => {
          const preview = (styleEl.textContent ?? '').slice(0, 120);
          styleEl.remove();
          return preview;
        });

      if (process.env.NODE_ENV !== 'production') {
        // Keep the payload compact but useful for debugging.
        // eslint-disable-next-line no-console
        console.info('[cookie-consent] scrubbed', {
          removedSelectors,
          removedScripts,
          removedIframes,
          removedStylesCount: removedStyles.length,
        });
      }
    };

    // Run once immediately (covers CMPs injected before hydration)...
    removeArtifacts();

    // ...and keep watching briefly for late injections (e.g. GTM).
    let scheduled = false;
    const hasCmpMarker = (node: Node) => {
      if (node.nodeType !== Node.ELEMENT_NODE) return false;
      const el = node as Element;

      // Fast checks on the element itself.
      const id = (el.getAttribute('id') ?? '').toLowerCase();
      const className = (el.getAttribute('class') ?? '').toLowerCase();
      const tag = el.tagName.toLowerCase();
      const src = (el.getAttribute('src') ?? '').toLowerCase();

      if (id.includes('onetrust') || id.includes('optanon') || id.includes('cookiebot') || id.includes('cybot')) return true;
      if (id.includes('qc-cmp') || id.includes('quantcast') || id.includes('iubenda') || id.includes('osano')) return true;
      if (id.startsWith('cky') || className.includes('cky-') || className.includes('osano-cm')) return true;
      if ((tag === 'script' || tag === 'iframe') && matchesKnownCmpSrc(src)) return true;

      // If a wrapper node is inserted, check a small set of known markers within it.
      return (
        el.querySelector(
          [
            '#ot-sdk-btn',
            '#onetrust-consent-sdk',
            '#CybotCookiebotDialog',
            '#qc-cmp2-ui',
            '.cky-btn-revisit-wrapper',
            '.cky-consent-container',
            '.osano-cm-widget',
            '.iubenda-cs-container',
          ].join(', ')
        ) !== null
      );
    };

    const observer = new MutationObserver(records => {
      if (scheduled) return;
      const shouldScrub = records.some(r => Array.from(r.addedNodes).some(hasCmpMarker));
      if (!shouldScrub) return;
      scheduled = true;
      window.requestAnimationFrame(() => {
        scheduled = false;
        removeArtifacts();
      });
    });

    observer.observe(document.documentElement, { childList: true, subtree: true });

    const stopAfterMs = 30_000;
    const timeout = window.setTimeout(() => observer.disconnect(), stopAfterMs);

    return () => {
      window.clearTimeout(timeout);
      observer.disconnect();
    };
  }, []);

  return null;
}

