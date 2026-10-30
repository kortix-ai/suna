import { localizeUiCatalog } from '@kortix/ui/i18n';
import type { UiTranslator } from '@/i18n/translator';
import { WHITE_LABEL_TRANSLATION_KEYS } from '@/i18n/white-label-translation-keys.generated';

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
 * ACCURACY GATE — the source of truth is `WHITE-LABEL-LICENSE.md` at the
 * repository root (the Exclusive Compute Agreement). Every term below restates
 * it; change the agreement first, then this file.
 *
 *  1. The license is free. Its one requirement is Platinum.dev as exclusive
 *     compute for every service Platinum.dev offers: sandboxes today; volumes,
 *     runners, AI compute and inference once offered and used by Kortix, with
 *     90 days to move (agreement §3).
 *  2. Kortix may end the default agreement at any time with notice. The
 *     partner then has up to 90 days to move existing customers (§11).
 *  3. Rates: a commitment to competitive rates, with match-or-release (§4).
 *     NOT "the most affordable" and NOT "cheaper than nearly everyone": no row
 *     in `claims.md` backs a superlative, so the page does not say it.
 *  4. Platinum.dev sandboxes are hardware-isolated microVMs (`claims.md`,
 *     isolation rule). No boot-time number: the kit bans latency claims.
 *  5. Platinum.dev signup is closed today. Access is by request, so step 2 says
 *     so instead of linking a signup form.
 */

export const SIGN_URL = 'https://app.documenso.com/d/gaAaA6NPc_E9c6C-sl9YB';
export const AGREEMENT_URL = 'https://github.com/kortix-ai/suna/blob/dev/WHITE-LABEL-LICENSE.md';
export const CUSTOM_TERMS_URL = 'mailto:marko@kortix.ai';

/** The real config a licensed partner sets: agreement, "After you sign", step 2. */
export const ENV_LINES = [
  '# API environment of your deployment',
  'ALLOWED_SANDBOX_PROVIDERS=platinum',
  'PLATINUM_API_KEY=pt_live_...',
  'PLATINUM_API_URL=https://api.platinum.dev',
] as const;

export const hero = {
  eyebrow: 'White-label',
  title: 'Build your own AI product on Kortix.',
  sub: 'Fork Kortix, put your brand on it, and sell it as your own: a vertical AI product, a wrapper, or a whole cloud business. The license is free. The one requirement is that your compute runs on Platinum.dev.',
  ctaPrimary: 'Sign the agreement',
  ctaPrimaryHref: SIGN_URL,
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
  eyebrow: 'The deal',
  title: 'Everything is yours to change. The compute is ours.',
  sub: 'One requirement, stated in full. Nothing else in the agreement restricts what you build.',
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
    title: 'What you commit to',
    items: [
      'Every sandbox your product starts runs on Platinum.dev, from the day you sign.',
      'Volumes, runners, AI compute and inference move to Platinum.dev once it offers them and Kortix uses them. You get 90 days to move.',
      'You keep the copyright and license notices in the source. Your customers never need to see Kortix.',
    ],
  },
} as const;

export const platinum = {
  eyebrow: 'Platinum.dev',
  title: 'The one thing you need from us is compute.',
  sub: 'Platinum.dev is the compute floor under Kortix. As long as your product runs on it, build any wrapper or cloud business you want.',
  rows: [
    {
      id: 'sandboxes',
      k: 'Sandboxes',
      v: 'Each Platinum.dev sandbox is a hardware-isolated microVM. Every session your product starts gets its own.',
    },
    {
      id: 'services',
      k: 'Every new service',
      v: 'Volumes, runners, AI compute and inference join the agreement as Platinum.dev offers them and Kortix uses them.',
    },
    {
      id: 'rates',
      k: 'Competitive rates',
      v: 'Platinum.dev commits to rates that are competitive with comparable providers. Show us a lower rate for a comparable service, and Kortix matches it or releases you for that service.',
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
  title: 'Sign, connect, rebrand.',
  sub: 'Three steps, and no call with us unless you want custom terms.',
  items: [
    {
      n: '01',
      k: 'Sign the agreement online',
      v: 'It takes about two minutes. It is in force when you sign, and Kortix does not countersign. The signed copy arrives by email.',
    },
    {
      n: '02',
      k: 'Get Platinum.dev access',
      v: 'Create an API key in the Platinum.dev dashboard. Access is by request today: email marko@kortix.ai from the address you signed with.',
    },
    {
      n: '03',
      k: 'Point your Kortix at Platinum.dev and rebrand',
      v: 'Set three values in your API environment, on any infrastructure. Then change the code, or upload your name and logo in Branding settings.',
    },
  ],
  panelTitle: 'API environment',
} as const;

export const terms = {
  eyebrow: 'The agreement',
  title: 'A free default, and custom terms when you need them.',
  sub: 'Anyone can sign the default online. A custom agreement that both sides sign controls over it.',
  rows: [
    {
      id: 'cost',
      k: 'Cost',
      v: 'The license is free. You pay Platinum.dev only for the compute you use.',
    },
    {
      id: 'term',
      k: 'Term',
      v: 'The default runs until either side ends it. You may leave at any time.',
    },
    {
      id: 'ending',
      k: 'If Kortix ends it',
      v: 'Kortix may end the default agreement with notice. You then have up to 90 days to move existing customers. After that, the open-source terms apply as they do to everyone.',
    },
    {
      id: 'custom',
      k: 'Custom agreements',
      v: 'A fixed term, committed volumes, dedicated capacity or other terms. Email marko@kortix.ai.',
    },
  ],
  readLabel: 'Read the full agreement',
} as const;

export const closing = {
  eyebrow: 'Get a license',
  title: 'Sign the agreement and start building.',
  sub: 'The license is in force the moment you sign. Your product, your brand, our compute.',
  primaryLabel: 'Sign the agreement',
  secondaryLabel: 'Read the agreement',
  tertiaryLabel: 'Ask for custom terms',
} as const;

export function getLocalizedWhiteLabelContent(tI18nComplete: UiTranslator) {
  return localizeUiCatalog(
    { hero, scenarios, deal, platinum, steps, terms, closing },
    tI18nComplete,
    WHITE_LABEL_TRANSLATION_KEYS,
  );
}
