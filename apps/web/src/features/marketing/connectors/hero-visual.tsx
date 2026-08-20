'use client';

import { favicon } from '@/components/home/interactive-demo/data';
import { EASE_OUT, LEAD, panel } from '@/features/marketing/component/hero-motion';
import { m, useReducedMotion } from 'motion/react';
import type { ReactNode } from 'react';
import { broker } from './content';

/**
 * `/connectors` hero scene — the wall.
 *
 * The whole page is one boundary argument: your credentials live on one side,
 * the machine lives on the other, and nothing carries a key across. So the
 * scene is that boundary, drawn once and drawn literally.
 *
 * The composition, deliberately, is not a centred panel:
 *  - the app wall runs off the left and both vertical edges and dissolves into
 *    the boundary, so the catalog reads as larger than the frame;
 *  - one card straddles the boundary, low and right of centre, elevated;
 *  - the dashed line continues *through* that card as its internal divider, so
 *    the card is not sitting near the wall — it is the crossing.
 *
 * Real data throughout: live favicons of apps the catalog carries, the call
 * shape from `broker.flow`, and the single token from `broker.after`. The
 * page's gate forbids implying a credential ever reaches the sandbox, which is
 * why the right half of the card holds exactly one line.
 *
 * MOTION — one pass on mount, then rest.
 */

/** Real catalog domains, ordered so no two neighbours read as one blob. */
const APPS = [
  'slack.com',
  'notion.so',
  'github.com',
  'linear.app',
  'stripe.com',
  'gmail.com',
  'figma.com',
  'hubspot.com',
  'salesforce.com',
  'airtable.com',
  'shopify.com',
  'zoom.us',
  'asana.com',
  'atlassian.com',
  'sentry.io',
  'datadoghq.com',
  'vercel.com',
  'cloudflare.com',
  'supabase.com',
  'mongodb.com',
  'twilio.com',
  'zendesk.com',
  'intercom.com',
  'gitlab.com',
  'dropbox.com',
  'calendly.com',
  'openai.com',
  'anthropic.com',
  'docker.com',
  'okta.com',
  'ramp.com',
  'plaid.com',
  'segment.com',
  'posthog.com',
  'miro.com',
  'greenhouse.io',
];

const COLUMNS = 6;
const ROWS = Array.from({ length: Math.ceil(APPS.length / COLUMNS) }, (_, r) =>
  APPS.slice(r * COLUMNS, r * COLUMNS + COLUMNS),
);

/** Where the boundary sits in the scene, and where it lands inside the card. */
const WALL = 58;
const CARD_LEFT = 14;
const CARD_RIGHT = 2;
const DIVIDER = ((WALL - CARD_LEFT) / (100 - CARD_LEFT - CARD_RIGHT)) * 100;

/** `connector.call("gmail", "send_email", {…})` — the real call shape. */
const CALL = broker.flow[0]?.mono ?? '';
/** The one thing the sandbox actually carries. */
const TOKEN = broker.after.lines[0];

export function ConnectorsHeroVisual(): ReactNode {
  const reduceMotion = useReducedMotion() ?? false;

  return (
    <div
      className="flex w-full items-center justify-center"
      role="img"
      aria-label="Thousands of connected apps on one side of a boundary, and the sandbox on the other, carrying a single scoped token and no credential."
    >
      <div className="relative h-[23rem] w-full max-w-[38rem] overflow-hidden sm:h-[26rem]">
        {/* ── the catalog, larger than the frame ──────────────────────── */}
        <div
          className="absolute inset-y-0 -left-14 flex w-[74%] flex-col justify-center gap-2.5 mask-y-from-70% mask-y-to-100% mask-x-from-55% mask-x-to-100%"
          aria-hidden
        >
          {ROWS.map((row, r) => (
            <div
              key={r}
              className="flex flex-none gap-2.5"
              // Brick offset: odd rows shift half a pitch so the field never
              // reads as a spreadsheet.
              style={{ transform: r % 2 === 1 ? 'translateX(1.4rem)' : undefined }}
            >
              {row.map((domain, c) => (
                <m.span
                  key={domain}
                  className="border-border bg-popover flex size-11 flex-none items-center justify-center rounded-[0.7rem] border"
                  initial={reduceMotion ? false : { opacity: 0, scale: 0.88 }}
                  animate={{ opacity: 1, scale: 1 }}
                  transition={{
                    duration: 0.38,
                    delay: 0.04 + (r * 0.6 + c) * 0.022,
                    ease: EASE_OUT,
                  }}
                >
                  <img
                    src={favicon(domain)}
                    alt=""
                    aria-hidden
                    loading="lazy"
                    decoding="async"
                    className="size-5 object-contain"
                  />
                </m.span>
              ))}
            </div>
          ))}
        </div>

        {/* ── the boundary ────────────────────────────────────────────── */}
        <m.span
          className="border-border absolute inset-y-0 origin-top border-l border-dashed"
          style={{ left: `${WALL}%` }}
          initial={reduceMotion ? false : { scaleY: 0, opacity: 0 }}
          animate={{ scaleY: 1, opacity: 1 }}
          transition={{ duration: 0.5, delay: LEAD + 0.1, ease: EASE_OUT }}
          aria-hidden
        />
        <m.span
          className="text-muted-foreground/40 absolute top-6 origin-left font-mono text-[10px] tracking-widest whitespace-nowrap uppercase"
          style={{ left: `${WALL}%`, transform: 'translateX(0.75rem)' }}
          initial={reduceMotion ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.3, delay: LEAD + 0.3, ease: EASE_OUT }}
          aria-hidden
        >
          the wall
        </m.span>

        {/* ── how many, said quietly ──────────────────────────────────── */}
        <m.span
          className="text-muted-foreground/45 absolute top-6 left-1 font-mono text-[10px] tracking-widest uppercase"
          initial={reduceMotion ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.3, delay: LEAD + 0.34, ease: EASE_OUT }}
          aria-hidden
        >
          3,000+ connected
        </m.span>

        {/* ── the crossing ────────────────────────────────────────────── */}
        <m.div
          className="border-border/70 bg-card/95 absolute bottom-[9%] overflow-hidden rounded-lg border shadow-2xl backdrop-blur-xl"
          style={{ left: `${CARD_LEFT}%`, right: `${CARD_RIGHT}%` }}
          {...panel(reduceMotion)}
        >
          <div className="grid" style={{ gridTemplateColumns: `${DIVIDER}% minmax(0,1fr)` }}>
            {/* outside: the call is assembled here, with the credential */}
            <div className="border-border/70 border-r border-dashed px-4 py-4">
              <span className="text-muted-foreground/45 block font-mono text-[10px] tracking-widest uppercase">
                the call
              </span>
              <p className="text-foreground/90 mt-2.5 font-mono text-[11px] leading-[1.6] break-words">
                {CALL}
              </p>
            </div>

            {/* inside: exactly one line, because that is all there is */}
            <div className="px-4 py-4">
              <span className="text-muted-foreground/45 block font-mono text-[10px] tracking-widest uppercase">
                in the sandbox
              </span>
              <p className="text-foreground mt-2.5 font-mono text-[11px] leading-[1.6] break-words">
                {TOKEN}
              </p>
              <p className="text-muted-foreground/55 mt-2 text-[11px] leading-snug text-pretty">
                {broker.after.title}
              </p>
            </div>
          </div>
        </m.div>
      </div>
    </div>
  );
}
