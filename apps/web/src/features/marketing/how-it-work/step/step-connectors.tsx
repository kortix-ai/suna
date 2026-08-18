'use client';

import { favicon } from '@/components/home/interactive-demo/data';
import { KortixLogo } from '@/components/ui/kortix-logo';
import { IconFrame } from '@/components/ui/marketing/icon-frame';
import { m, useReducedMotion } from 'motion/react';
import { useCallback, useState, type ReactNode } from 'react';
import { useStepShowcaseStart } from '../use-step-showcase';

/**
 * The wall. Real favicons of apps the catalog actually carries — the claim is
 * "every tool your company already runs on", so a mock tile would be worth
 * nothing here. The list is longer than any viewport shows on purpose: the rows
 * run past both edges and the mask dissolves them, which is what reads as
 * "and thousands more" without printing a number.
 *
 * Order matters visually, not semantically: adjacent tiles are kept different
 * in color and weight so no two neighbours read as one blob.
 */
const APPS: string[] = [
  'slack.com',
  'notion.so',
  'github.com',
  'linear.app',
  'figma.com',
  'stripe.com',
  'hubspot.com',
  'salesforce.com',
  'gmail.com',
  'drive.google.com',
  'atlassian.com',
  'airtable.com',
  'shopify.com',
  'zoom.us',
  'asana.com',
  'discord.com',
  'twilio.com',
  'sendgrid.com',
  'zendesk.com',
  'intercom.com',
  'gitlab.com',
  'dropbox.com',
  'calendly.com',
  'mailchimp.com',
  'openai.com',
  'anthropic.com',
  'x.ai',
  'deepseek.com',
  'mistral.ai',
  'perplexity.ai',
  'huggingface.co',
  'vercel.com',
  'netlify.com',
  'cloudflare.com',
  'aws.amazon.com',
  'azure.microsoft.com',
  'cloud.google.com',
  'digitalocean.com',
  'supabase.com',
  'mongodb.com',
  'redis.io',
  'snowflake.com',
  'databricks.com',
  'datadoghq.com',
  'sentry.io',
  'pagerduty.com',
  'posthog.com',
  'amplitude.com',
  'mixpanel.com',
  'segment.com',
  'looker.com',
  'tableau.com',
  'xero.com',
  'ramp.com',
  'brex.com',
  'plaid.com',
  'docusign.com',
  'box.com',
  'workday.com',
  'gusto.com',
  'rippling.com',
  'greenhouse.io',
  'lever.co',
  'webflow.com',
  'wordpress.com',
  'contentful.com',
  'sanity.io',
  'algolia.com',
  'elastic.co',
  'temporal.io',
  'circleci.com',
  'docker.com',
  'hashicorp.com',
  '1password.com',
  'okta.com',
  'auth0.com',
  'cloudinary.com',
  'miro.com',
];

/** 13 per row × 6 rows. Wider than the panel — the overflow is the point. */
const COLUMNS = 13;
const ROWS: string[][] = Array.from({ length: Math.ceil(APPS.length / COLUMNS) }, (_, row) =>
  APPS.slice(row * COLUMNS, row * COLUMNS + COLUMNS),
);

const ROW_COUNT = ROWS.length;
const CENTER_ROW = (ROW_COUNT - 1) / 2;
const CENTER_COL = (COLUMNS - 1) / 2;

/**
 * Tiles come in from the middle outward, so the eye lands on the Kortix mark
 * first and the catalog spreads out under it. Distance is measured in tiles,
 * halved on the row axis because rows are the shorter travel.
 */
function tileDelay(row: number, col: number): number {
  const dx = col - CENTER_COL;
  const dy = (row - CENTER_ROW) * 1.6;
  return Math.sqrt(dx * dx + dy * dy) * 0.028;
}

/**
 * Layer 02 — the app wall with the Kortix mark sitting on top of it.
 *
 * Geometry runs off two custom properties: `--tile` is the square, `--gap` the
 * space between two. Every other row is pushed half a pitch to the right, which
 * is what stops the wall reading as a spreadsheet. Both properties are set once
 * on the root and every child derives from them, so one breakpoint change
 * rescales the whole thing — tiles, offsets and the center mark together.
 */
export function StepConnectors(): ReactNode {
  const reduced = useReducedMotion();
  const [started, setStarted] = useState(false);
  const rootRef = useStepShowcaseStart(useCallback(() => setStarted(true), []));
  const shown = started || !!reduced;

  return (
    <div
      ref={rootRef}
      className="relative isolate h-full w-full overflow-hidden [--gap:0.5rem] [--tile:2.5rem] sm:[--gap:0.625rem] sm:[--tile:3.25rem] xl:[--tile:3.75rem]"
    >
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-[var(--gap)] mask-y-from-68% mask-y-to-100% mask-x-from-72% mask-x-to-100% opacity-50">
        {ROWS.map((row, rowIndex) => (
          <div
            key={rowIndex}
            className="flex flex-none gap-[var(--gap)]"
            // Brick offset: odd rows shift by half a pitch (tile + gap).
            style={{
              transform:
                rowIndex % 2 === 1 ? 'translateX(calc((var(--tile) + var(--gap)) / 2))' : undefined,
            }}
          >
            {row.map((domain, colIndex) => (
              <m.div
                key={domain}
                initial={reduced ? false : { opacity: 0, scale: 0.86 }}
                animate={shown ? { opacity: 1, scale: 1 } : undefined}
                transition={{
                  duration: 0.4,
                  ease: [0.16, 1, 0.3, 1],
                  delay: tileDelay(rowIndex, colIndex),
                }}
                className="border-border bg-popover flex size-[var(--tile)] flex-none items-center justify-center rounded-[calc(var(--tile)*0.26)] border"
              >
                <img
                  src={favicon(domain)}
                  alt=""
                  aria-hidden
                  loading="lazy"
                  decoding="async"
                  className="size-[calc(var(--tile)*0.46)] object-contain"
                />
              </m.div>
            ))}
          </div>
        ))}
      </div>

      {/* The mark sits on top of the wall, opaque, one plane above it. */}
      <div className="pointer-events-none absolute inset-0 grid place-items-center">
        <IconFrame className="size-[calc(var(--tile)*2)]">
          <KortixLogo variant="icon" />
        </IconFrame>
      </div>
    </div>
  );
}
