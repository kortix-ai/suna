import { MARKETING_RELEASE_TRANSLATION_KEYS } from '@/i18n/marketing-release-translation-keys.generated';
import { localizeUiCatalog } from '@kortix/ui/i18n';
/**
 * Case studies for the CompanyOS home page and /services: eight cards in one horizontal row. No
 * card links anywhere, by founder decision.
 *
 * ACCURACY AND NAMING (read before editing):
 *  - Named cases, each a founder decision: HKAI-Sci / SciencePal (2026-10-22,
 *    2026-10-27: the City University of Hong Kong logo), Wring and Platinum
 *    (2026-10-27), WRITER (name 2026-10-22, logo 2026-10-27). "Built from
 *    Kortix's open-source code" is a product built from the public repo:
 *    never "customer" or "partner", never a licence claim. WRITER's brand
 *    terms forbid implying endorsement: no "uses Kortix", no quote. The
 *    customers named on the WRITER card are WRITER's own, from writer.com
 *    (2026-10-27): never say they use Kortix. The CityU logo is
 *    CityU's trade mark (its logo/name policy): remove it on request.
 *  - SciencePal facts: CityU press release 2025-11-05. Wring: wring.co and
 *    its Kortix project. Platinum: platinum.dev and its repo's `kortix.yaml`
 *    (engineer and QA agents, Linear). Kortix: the `kortix-ai/company`
 *    project (engineering factory, compliance agency, sales, support and
 *    marketing agents).
 *  - The asset manager is Kortix's own simulated fund (`kortix-ai/hedgefund`,
 *    its CASE-STUDY.md): real public market data, simulated investors,
 *    capital and trades, agents front to back office, a person at every
 *    gate. Always say it is ours and that the capital is simulated.
 *  - Bodies stay minimal (founder, 2026-11-02): one or two short sentences
 *    on what the agents do there. Only the WRITER card says "built from
 *    Kortix's open-source code".
 *  - Every other case is a CLASS, never a name. Customer names are blocked
 *    commit terms (CLAUDE.md, `scripts/check-blocked-terms.sh`). Keep each
 *    class broad enough that it does not identify the company: no founding
 *    year, no office count, no city.
 *  - The telecom card describes the company's own Kortix project (its
 *    agents and skills, read 2026-10-27). Never name its places, clients
 *    or systems: they identify it.
 *  - Only what the engagement really contains. No metric, no quote, no
 *    outcome number until the company signs one off.
 *  - The asset manager and executive search logos are lockups Kortix drew
 *    for these cards (founder, 2026-11-02; brand decision D35): a symbol
 *    plus the class as type ("ASSET MANAGEMENT", "EXECUTIVE SEARCH"). They are
 *    not the firm's real logo. Never put a firm name in them, and never copy
 *    a real firm's logo.
 */

export type CaseStudy = {
  id: string;
  /** A logo on a white tile (third-party, or drawn for a named class), a drawn brand mark, or a Phosphor glyph. */
  logo?: { src: string; alt: string; width: number; height: number };
  mark?: 'kortix' | 'platinum';
  icon?: 'telecom';
  category: string;
  /** Who it is, as a name (logo cases) or a class. */
  org: string;
  title: string;
  body: string;
  facts: readonly string[];
};

export const caseStudies: { title: string; titleMuted: string; items: readonly CaseStudy[] } = {
  title: 'Case studies.',
  titleMuted: 'What runs on Kortix today.',
  items: [
    {
      id: 'hkai-sci',
      logo: {
        src: '/media/case-studies/cityu.svg',
        alt: 'City University of Hong Kong',
        width: 262,
        height: 147,
      },
      category: 'Research',
      org: 'Hong Kong Institute of AI for Science, City University of Hong Kong',
      title: 'SciencePal: a science agent for researchers.',
      body: 'The institute’s AI research assistant. It searches the scientific literature with citations and runs agents for protein design and materials science.',
      facts: [
        'Literature search with citations',
        'A protein design agent',
        'A materials science agent',
        'Property prediction to experiment design',
      ],
    },
    {
      id: 'platinum',
      mark: 'platinum',
      category: 'Cloud infrastructure',
      org: 'Platinum',
      title: 'An autonomous cloud company.',
      body: 'A sandbox cloud for AI agents, run by agents on Kortix. Agents ship changes from Linear issues and test every flow. People approve.',
      facts: [
        'Engineering agents ship from Linear issues',
        'QA agents test every flow on video',
        'MicroVM sandboxes that boot in 400 ms',
        'Every Kortix session runs on Platinum',
      ],
    },
    {
      id: 'telecom',
      icon: 'telecom',
      category: 'Telecommunications',
      org: 'A leading US telecommunications infrastructure company',
      title: 'Fiber network design, run by agents.',
      body: 'Agents design fiber routes from GIS data and imagery, build bills of materials and track every project, self-hosted in the company’s own cloud.',
      facts: [
        'Fiber routes designed from GIS and imagery',
        'Bills of materials from GIS layers',
        'Schedule health across every project',
        'Self-hosted in its own cloud, with SSO',
      ],
    },
    {
      id: 'kortix',
      mark: 'kortix',
      category: 'Software',
      org: 'Kortix',
      title: 'Kortix, run on Kortix.',
      body: 'Our company is one Kortix project. Agents triage and fix issues, keep SOC 2 evidence current and run sales and support. People approve.',
      facts: [
        'Issues triaged by an intake agent',
        'Up to 16 worker agents at once',
        'SOC 2 policies kept current by agents',
        'Sales, support and marketing agents',
      ],
    },
    {
      id: 'asset-management',
      logo: {
        src: '/media/case-studies/asset-management.svg',
        alt: 'An AI-run asset manager.',
        width: 409,
        height: 100,
      },
      category: 'Asset management',
      org: 'Built and run by Kortix',
      title: 'An AI-run asset manager.',
      body: 'Our own fund, on real market data with simulated capital. Agents research, trade, value the book, strike NAV and run compliance. A person signs every decision.',
      facts: [
        'Research, IC and trading',
        'Risk, valuation and NAV',
        'Compliance and investor reporting',
        'Real market data, simulated capital',
      ],
    },
    {
      id: 'executive-search',
      logo: {
        src: '/media/case-studies/executive-search.svg',
        alt: 'An international executive search firm',
        width: 349,
        height: 100,
      },
      category: 'Professional services',
      org: 'An international executive search firm',
      title: 'An executive search firm, rebuilt around agents.',
      body: 'Agents research candidates, prepare client and pitch materials and run the firm’s internal operations.',
      facts: [
        'Candidate research agents',
        'Client and pitch materials',
        'Internal operations automated',
        'The whole firm on one CompanyOS',
      ],
    },
    {
      id: 'writer',
      logo: { src: '/media/case-studies/writer.svg', alt: 'WRITER', width: 110, height: 35 },
      category: 'Enterprise AI',
      org: 'WRITER',
      title: 'The enterprise AI platform, built from Kortix’s open-source code.',
      body: 'Enterprises such as Salesforce, Vanguard and KPMG run their marketing, sales and support agents on WRITER.',
      facts: [
        'Core platform built from Kortix’s code',
        'Salesforce, Vanguard and KPMG',
        'Dropbox, H&R Block and Boots',
        'Agents for marketing, sales and support',
      ],
    },
    {
      id: 'wring',
      logo: { src: '/media/case-studies/wring.svg', alt: 'Wring', width: 74, height: 28 },
      category: 'Cloud cost',
      org: 'Wring',
      title: 'Autonomous AWS cost optimization.',
      body: 'Agents find the AWS credit programs each customer qualifies for and prepare the applications. The customer approves.',
      facts: [
        'Credit programs found per customer',
        'Applications prepared by agents',
        'A person approves every submission',
        'Runs as one Kortix project',
      ],
    },
  ],
};

export function localizeMarketingContent(tMarketing: import('@/i18n/translator').UiTranslator) {
  return localizeUiCatalog({ caseStudies }, tMarketing, MARKETING_RELEASE_TRANSLATION_KEYS);
}
