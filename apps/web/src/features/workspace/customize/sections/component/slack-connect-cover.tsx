'use client';

/**
 * The Slack hero's cover art — the `Slack × Kortix` lockup, on the Kortix
 * gradient, from the same component the blog uses.
 *
 * ## What this replaced, and why
 *
 * This file used to be `slack-thread-preview.tsx`: ~130 lines hand-drawing a
 * fake Slack thread (channel bar, two avatars, a mention pill, a "Task
 * complete" card) in tokens. It was written to avoid shipping
 * `public/usecases/slack/operation_1.JPEG` — 520 KB and a capture of Slack's
 * DARK theme, so a black rectangle on a light panel. Avoiding the JPEG was
 * right; hand-drawing the replacement was not, because `BlogCover`
 * (`@/components/blog/blog-cover`) already renders exactly this treatment:
 * real brand SVGs on chips over the Kortix gradient with the grain overlay,
 * theme-aware, already used by `post-card.tsx` and the blog post page.
 *
 * So the cover is now the shipped component, and this module is the thin
 * wrapper holding the Slack-specific configuration — the same shape
 * `computers-view.tsx` uses to delegate to `TunnelOverview`.
 *
 * ## Two things this required upstream
 *
 * `BRAND_ICONS` in `blog-cover.tsx` had no `slack` key, so `LogoChip` fell
 * through to its favicon fallback: `https://www.google.com/s2/favicons?
 * domain=slack.com` — a third-party network request, on a settings page, for a
 * mark this repo already ships as `@/features/icon/icons/slack`. Registering
 * it fixes this surface and any future Slack-tagged blog post at once.
 *
 * ## Aspect
 *
 * `BlogCover` has no intrinsic height; every caller sets one. The blog uses
 * `aspect-[16/9]`, which at the customize panel's `max-w-2xl` (672px) would be
 * a 378px hero on a settings page — taller than the copy it introduces. A wide
 * N/1 ratio keeps it a band rather than a billboard: at 672px, `aspect-[3/1]`
 * is ~224px, enough air around the 56/64px chips to read as deliberate.
 */

import { BlogCover } from '@/components/blog/blog-cover';
import { cn } from '@/lib/utils';

export function SlackConnectCover({ className }: { className?: string }) {
  return (
    // Hidden on the wrapper rather than passed to BlogCover, whose props are
    // just `logos`/`withKortix`/`className` — widening them to spread div
    // attributes would change a component the blog renders, for one caller.
    //
    // Decorative, deliberately: the lockup says "Slack and Kortix", and the
    // <h3>Slack</h3> plus the lede directly beneath it already say exactly that
    // in text. Labelling it would make a screen reader announce it twice.
    <div aria-hidden className={cn('w-full scale-120 overflow-hidden', className)}>
      <BlogCover logos={[{ domain: 'slack.com', name: 'Slack' }]} className="aspect-[3/1] w-full" />
    </div>
  );
}
