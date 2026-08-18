'use client';

import { EASE_OUT, LEAD, panel } from '@/features/marketing/component/hero-motion';
import { m, useReducedMotion } from 'motion/react';
import { useTranslations } from 'next-intl';
import type { ReactNode } from 'react';

/**
 * `/enterprise` hero scene — the field of controls, with one picked up.
 *
 * A buyer's question is "which of these do you have", and the honest shape of
 * that answer is a field, not a ticked list. So the scene is a dense grid of
 * control tiles that runs off the right edge, with a single tile lifted out of
 * it, enlarged, and given its description.
 *
 * Composition:
 *  - the grid bleeds right and is masked there, so the roster reads as longer
 *    than the frame;
 *  - one tile is promoted to a card at a different scale entirely, overlapping
 *    the grid it came from;
 *  - a hairline connects the card back to the slot it left, so the promotion is
 *    legible rather than arbitrary.
 *
 * Copy comes from the same `hardcodedUi.appHomeEnterprisePage` namespace the
 * page already renders, so hero and sections cannot drift. This is the only
 * capability hero reading from translations, because this page has no
 * `content.ts`.
 *
 * MOTION — one pass on mount, then rest.
 */

const CONTROLS = [
  'checklistSaml',
  'checklistScim',
  'checklistRbac',
  'checklistAudit',
  'checklistSandboxes',
  'checklistSecrets',
  'checklistGateway',
] as const;

/** The one lifted out. RBAC, because "who can do what" is the page's question. */
const FOCUS = 2;

export function EnterpriseHeroVisual(): ReactNode {
  const reduceMotion = useReducedMotion() ?? false;
  const t = useTranslations('hardcodedUi.appHomeEnterprisePage');

  return (
    <div
      className="flex w-full items-center justify-center"
      role="img"
      aria-label={`${t('identityAccessEyebrow')}: the controls this platform ships, with ${t('checklistRbacTitle')} shown in full.`}
    >
      <div className="relative h-[23rem] w-full max-w-[38rem] overflow-hidden sm:h-[26rem]">
        {/* ── the roster, running off the right edge ──────────────────── */}
        <div
          className="absolute inset-x-0 top-[8%] grid grid-cols-3 gap-2.5 mask-x-from-78% mask-x-to-100%"
          style={{ width: '124%' }}
          aria-hidden
        >
          {CONTROLS.map((key, i) => (
            <m.span
              key={key}
              className={
                i === FOCUS
                  ? 'border-border/50 bg-background/40 flex h-14 items-center rounded-lg border border-dashed px-3'
                  : 'border-border/70 bg-card/70 flex h-14 items-center rounded-lg border px-3'
              }
              initial={reduceMotion ? false : { opacity: 0, y: 8 }}
              animate={{ opacity: i === FOCUS ? 0.5 : 1, y: 0 }}
              transition={{ duration: 0.36, delay: 0.06 + i * 0.04, ease: EASE_OUT }}
            >
              <span
                className={
                  i === FOCUS
                    ? 'text-muted-foreground/40 text-[11.5px] leading-tight'
                    : 'text-foreground/75 text-[11.5px] leading-tight'
                }
              >
                {t(`${key}Title`)}
              </span>
            </m.span>
          ))}
        </div>

        {/* ── the hairline back to the slot it left ───────────────────── */}
        <m.span
          className="border-border absolute border-l border-dashed"
          style={{ left: '46%', top: '22%', height: '24%' }}
          initial={reduceMotion ? false : { scaleY: 0, opacity: 0 }}
          animate={{ scaleY: 1, opacity: 1 }}
          transition={{ duration: 0.3, delay: LEAD + 0.34, ease: EASE_OUT }}
          aria-hidden
        />

        {/* ── the one lifted out ──────────────────────────────────────── */}
        <m.div
          className="border-border/70 bg-card absolute right-[4%] bottom-[8%] left-[8%] rounded-xl border p-5 shadow-2xl"
          {...panel(reduceMotion)}
        >
          <span className="text-muted-foreground/50 block font-mono text-[10px] tracking-widest uppercase">
            {t('identityAccessEyebrow')}
          </span>
          <p className="text-foreground mt-3 text-[17px] leading-tight font-medium">
            {t('checklistRbacTitle')}
          </p>
          <p className="text-muted-foreground/60 mt-2.5 text-[13px] leading-snug text-pretty">
            {t('checklistRbacDescription')}
          </p>
        </m.div>
      </div>
    </div>
  );
}
