import type { UiTranslator } from '@/i18n/translator';
import { WHITE_LABEL_TRANSLATION_KEYS } from '@/i18n/white-label-translation-keys.generated';
import { localizeUiCatalog } from '@kortix/ui/i18n';

/**
 * `/white-label` copy.
 *
 * Plain English lives here. Every string is also a `hardcodedUi.i18nComplete`
 * key in the nine catalogs (`text` + the first 12 hex of its SHA-256), mapped in
 * `i18n/white-label-translation-keys.generated.ts`. Change a string and you
 * change its key: add the new key to all nine catalogs in the same commit.
 *
 * Voice rules: the `kortix-brand` skill. Never name a license — "open source"
 * and stop. Say "sandbox", never "container". No price, no invented number.
 *
 * ACCURACY GATE — the source of truth is the repository root: `LICENSE` (the
 * core is open source; anyone may fork, rebrand and sell it, also as a hosted
 * service), `ee/LICENSE` (Enterprise features need a subscription in
 * production) and `TRADEMARKS.md` (the Kortix name and logo stay with Kortix).
 * There is no agreement to sign.
 *
 *  1. Platinum.dev sandboxes are hardware-isolated microVMs (`claims.md`,
 *     isolation rule). No boot-time number: the kit bans latency claims.
 *  2. Platinum.dev signup is closed today. Access is by request, so step 2 says
 *     so instead of linking a signup form.
 */

export const GITHUB_URL = 'https://github.com/kortix-ai/suna';
export const LICENSE_URL = 'https://github.com/kortix-ai/suna/blob/dev/LICENSE';
export const ENTERPRISE_URL = 'mailto:marko@kortix.ai';

/** The real config a fork sets to run its sessions on Platinum.dev. */
export const ENV_LINES = [
  '# API environment of your deployment',
  'ALLOWED_SANDBOX_PROVIDERS=platinum',
  'PLATINUM_API_KEY=pt_live_...',
  'PLATINUM_API_URL=https://api.platinum.dev',
] as const;

export const hero = {
  eyebrow: 'White-label',
  title: 'Build your own AI product on Kortix.',
  sub: 'Fork Kortix, put your brand on it, and sell it as your own: a vertical AI product, a wrapper, or a whole cloud business. Kortix is open source, and there is no agreement to sign.',
  ctaPrimary: 'Fork on GitHub',
  ctaPrimaryHref: GITHUB_URL,
  ctaSecondary: 'How it works',
  ctaSecondaryHref: '#how-it-works',
  envTitle: '.env',
} as const;

export const scenarios = {
  eyebrow: 'What you can build',
  title: 'One horizontal platform. Your vertical product on top.',
  sub: 'Kortix gives you the agents, the sandboxes, the connectors and the repo underneath. You bring the market, the brand and the front end.',
  rows: [
    {
      id: 'vertical',
      k: 'Vertical AI',
      v: 'An AI product for one industry, such as legal, finance or operations, with its own agents, skills and front end.',
    },
    {
      id: 'wrapper',
      k: 'A wrapper',
      v: 'Kortix underneath, your interface and your plans on top. Your customers see one product: yours.',
    },
    {
      id: 'cloud',
      k: 'Your own AI cloud',
      v: 'A managed agent cloud under your own name, sold to your own customers on your own contracts.',
    },
    {
      id: 'embedded',
      k: 'Agents in your SaaS',
      v: 'Agents inside the product you already sell, with a front end built on the Kortix SDK.',
    },
    {
      id: 'agency',
      k: 'Agencies and consultancies',
      v: 'One branded platform you ship to every client, instead of rebuilding the same AI plumbing per client.',
    },
    {
      id: 'regional',
      k: 'Regional providers',
      v: 'Agents for your region, under your brand, your support and your terms.',
    },
    {
      id: 'internal',
      k: 'Internal platforms',
      v: "An AI platform for a large company, branded as the company's own tool.",
    },
  ],
} as const;

export const deal = {
  eyebrow: 'The license',
  title: 'Everything is yours to change.',
  sub: 'Kortix is open source. You need no agreement and no license key to build on it.',
  get: {
    title: 'What you get',
    items: [
      'Your name, logo, domain and colors in place of Kortix.',
      'Your structure: change the source, the navigation, the features and the defaults.',
      'The right to offer Kortix to your customers as a hosted service under your brand.',
      'The whole product, open source: read it, fork it, audit it.',
    ],
  },
  commit: {
    title: 'What stays with Kortix',
    items: [
      'The Kortix name and logo. Your product uses its own name and logo.',
      'Enterprise features (SAML single sign-on, SCIM, custom roles and groups, audit log export) need a Kortix Enterprise subscription in production.',
      'You keep the copyright and license notices in the source. Your customers never need to see Kortix.',
    ],
  },
} as const;

export const platinum = {
  eyebrow: 'Platinum.dev',
  title: 'Kortix runs on Platinum.dev.',
  sub: 'Platinum.dev is the compute provider under Kortix. Your product runs its sessions there.',
  rows: [
    {
      id: 'sandboxes',
      k: 'Sandboxes',
      v: 'Each Platinum.dev sandbox is a hardware-isolated microVM. Every session your product starts gets its own.',
    },
    {
      id: 'billing',
      k: 'One supplier',
      v: 'You pay Platinum.dev for the compute you use, through your own Platinum.dev account. You run no sandbox fleet of your own.',
    },
  ],
} as const;

export const steps = {
  eyebrow: 'How it works',
  title: 'Fork, connect, rebrand.',
  sub: 'Three steps. No call with us and no agreement.',
  items: [
    {
      n: '01',
      k: 'Fork the repository',
      v: 'Fork Kortix on GitHub, or clone it and run it on your own infrastructure.',
    },
    {
      n: '02',
      k: 'Get Platinum.dev access',
      v: 'Create an API key in the Platinum.dev dashboard. Access is by request today: email marko@kortix.ai.',
    },
    {
      n: '03',
      k: 'Point your Kortix at Platinum.dev and rebrand',
      v: 'Set three values in your API environment, on any infrastructure. Then change the code, or upload your name and logo in Branding settings.',
    },
  ],
  panelTitle: 'API environment',
} as const;

export const closing = {
  eyebrow: 'Start building',
  title: 'Fork Kortix and make it yours.',
  sub: 'Your product, your brand, on Platinum.dev compute.',
  primaryLabel: 'Fork on GitHub',
  secondaryLabel: 'Read the license',
  tertiaryLabel: 'Ask about Enterprise',
} as const;

export function getLocalizedWhiteLabelContent(tI18nComplete: UiTranslator) {
  return localizeUiCatalog(
    { hero, scenarios, deal, platinum, steps, closing },
    tI18nComplete,
    WHITE_LABEL_TRANSLATION_KEYS,
  );
}
