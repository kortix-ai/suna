/**
 * section4-content.ts — Enterprise & security (v2: accordion + synced stage)
 *
 * LAYOUT: 2-col grid. RIGHT = accordion (one item open at a time).
 * LEFT = "reactive stage": a single canvas whose animation switches to
 * match the open accordion item. Each claim demos itself — no static
 * lock-icon wall like every other security section.
 *
 * Stage states (see `visual` per item):
 *   isolation → sandboxes pop onto branches off main, CRs dash back
 *   token     → red API keys bounce off the boundary; one purple
 *               Kortix token slides through into the sandbox
 *   audit     → gateway log rows tick in (call · tool · commit · budget)
 *   soc2      → control checklist ticks; amber "in progress" badge pulses
 *   selfhost  → inner "kortix" box constant; outer dashed frame label
 *               cycles: managed cloud → your VPC → on-prem → air-gapped
 *
 * Motion: stagger reveals ~0.4s apart, fade-swap scenes in ~200ms,
 * loops gentle (<2s). Respect prefers-reduced-motion: render scenes
 * static, no bounce/pulse, no label cycling.
 *
 * HONESTY RULE: SOC 2 is IN PROGRESS — never "compliant"/"certified"
 * until the report lands. Update the item title that day, not before.
 */

export type StageVisual = 'isolation' | 'token' | 'audit' | 'soc2' | 'selfhost';

export type AccordionIcon = 'stack-2' | 'key' | 'eye' | 'shield' | 'server';

export type AccordionEntry = {
  id: string;
  icon: AccordionIcon;
  title: string;
  teaser: string;
  body: string;
  visual: StageVisual;
};

export const ACCORDION = [
  {
    id: 'isolation',
    icon: 'stack-2',
    title: 'enterpriseAccordionIsolationTitle',
    teaser: 'enterpriseAccordionIsolationTeaser',
    body: 'enterpriseAccordionIsolationBody',
    visual: 'isolation',
  },
  {
    id: 'soc2',
    icon: 'shield',
    title: 'enterpriseAccordionSoc2Title',
    teaser: 'enterpriseAccordionSocTeaserLabel',
    body: 'enterpriseAccordionSocBody',
    visual: 'soc2',
  },
  {
    id: 'selfhost',
    icon: 'server',
    title: 'enterpriseAccordionSelfhostTitle',
    teaser: 'enterpriseAccordionSelfhostTeaser',
    body: 'enterpriseAccordionSelfhostBody',
    visual: 'selfhost',
  },
] as const satisfies readonly AccordionEntry[];

/** Data the stage scenes render from (keep honest to real output/names) */
export const STAGE_DATA = {
  isolation: { sandboxes: ['s_1a', 's_7f', 's_3c'], spine: 'main' },
  token: {
    rejected: 'enterpriseStageTokenRejected',
    accepted: 'enterpriseStageTokenAccepted',
  },
  audit: {
    rowKeys: [
      'enterpriseStageAuditRow0',
      'enterpriseStageAuditRow1',
      'enterpriseStageAuditRow2',
      'enterpriseStageAuditRow3',
    ],
  },
  soc2: {
    controlKeys: [
      'enterpriseStageSoc2Control0',
      'enterpriseStageSoc2Control1',
      'enterpriseStageSoc2Control2',
      'enterpriseStageSoc2Control3',
    ],
    badge: 'enterpriseStageSocBadge',
  },
  selfhost: {
    hostKeys: [
      'enterpriseStageSelfhostHost0',
      'enterpriseStageSelfhostHost1',
      'enterpriseStageSelfhostHost2',
      'enterpriseStageSelfhostHost3',
    ],
    command: 'enterpriseStageSelfhostCommand',
  },
} as const;

export const CTA = {
  primary: { label: 'enterpriseCtaPrimary', href: '/enterprise' },
  secondary: { label: 'enterpriseCtaSecondary', href: '/docs/security' },
} as const;
