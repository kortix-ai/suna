import { MARKETING_RELEASE_TRANSLATION_KEYS } from '@/i18n/marketing-release-translation-keys.generated';
import { localizeUiCatalog } from '@kortix/ui/i18n';
/**
 * Case studies for the CompanyOS home page, /services and /case-studies: one
 * horizontal row (a grid on /case-studies). No card links anywhere, by founder
 * decision. A card shows its category, never the client's name (founder,
 * 2026-11-02). `hidden: true` keeps a card's copy here without showing it.
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
 *  - The asset manager card describes how an asset manager runs on Kortix
 *    end to end, in general terms (founder, 2026-11-02: no "own fund", no
 *    "simulated capital"). Its source is Kortix's own fund project
 *    (`kortix-ai/hedgefund`, CASE-STUDY.md): real public market data,
 *    simulated investors, capital and trades. Name only steps that project
 *    runs, and never a fund size, a return or a client.
 *  - Bodies stay minimal (founder, 2026-11-02): one or two short sentences
 *    on what the agents do there. Only the WRITER card says "built from
 *    Kortix's open-source code".
 *  - Every other case is a CLASS, never a name. Customer names are blocked
 *    commit terms (CLAUDE.md, `scripts/check-blocked-terms.sh`). Keep each
 *    class broad enough that it does not identify the company: no founding
 *    year, no office count, no city.
 *  - The telecom card describes the company's own Kortix project (its
 *    agents and skills, read 2026-10-27). Never name its places, clients
 *    or systems: they identify it. Its logo is the company's own mark, the
 *    symbol only with the wordmark cut out (founder, 2026-11-02). The file
 *    is `telecom.svg`: its name is a blocked term, so it appears nowhere here.
 *  - Only what the engagement really contains. No metric, no quote, no
 *    outcome number until the company signs one off.
 *  - The asset manager and executive search logos are symbols Kortix drew
 *    for these cards (founder, 2026-11-02; brand decision D35): no type at
 *    all. They are not the firm's real logo. Never add a name or text to
 *    them, and never copy a real firm's logo.
 */

export type CaseStudy = {
  id: string;
  /** A logo on a white tile (the client's own, or a symbol Kortix drew), or a drawn brand mark. */
  logo?: { src: string; alt: string; width: number; height: number };
  mark?: 'kortix' | 'platinum';
  /** Kept in this file, not shown anywhere. */
  hidden?: boolean;
  category: string;
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
      logo: {
        src: '/media/case-studies/telecom.svg',
        alt: 'A leading US telecommunications infrastructure company',
        width: 246,
        height: 278,
      },
      category: 'Telecommunications',
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
      id: 'asset-management',
      logo: {
        src: '/media/case-studies/asset-management.svg',
        alt: 'An AI-run asset manager.',
        width: 100,
        height: 100,
      },
      category: 'Asset management',
      title: 'An AI-run asset manager.',
      body: 'Agents run the firm front to back office: research, IC memos, trading, reconciliation, valuation, NAV, compliance and investor reporting. People sign every decision.',
      facts: [
        'Research, IC and trading',
        'Risk, valuation and NAV',
        'Compliance and investor reporting',
        'Settlement and reconciliation',
      ],
    },
    {
      id: 'executive-search',
      logo: {
        src: '/media/case-studies/executive-search.svg',
        alt: 'An international executive search firm',
        width: 100,
        height: 100,
      },
      category: 'Professional services',
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
      id: 'wring',
      logo: { src: '/media/case-studies/wring.svg', alt: 'Wring', width: 74, height: 28 },
      category: 'Cloud cost',
      title: 'Autonomous AWS cost optimization.',
      body: 'Agents find the AWS credit programs each customer qualifies for and prepare the applications. The customer approves.',
      facts: [
        'Credit programs found per customer',
        'Applications prepared by agents',
        'A person approves every submission',
        'Runs as one Kortix project',
      ],
    },
    {
      id: 'kortix',
      hidden: true,
      mark: 'kortix',
      category: 'Software',
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
      id: 'writer',
      hidden: true,
      logo: { src: '/media/case-studies/writer.svg', alt: 'WRITER', width: 110, height: 35 },
      category: 'Enterprise AI',
      title: 'The enterprise AI platform, built from Kortix’s open-source code.',
      body: 'Enterprises such as Salesforce, Vanguard and KPMG run their marketing, sales and support agents on WRITER.',
      facts: [
        'Core platform built from Kortix’s code',
        'Salesforce, Vanguard and KPMG',
        'Dropbox, H&R Block and Boots',
        'Agents for marketing, sales and support',
      ],
    },
  ],
};

export function localizeMarketingContent(tMarketing: import('@/i18n/translator').UiTranslator) {
  return localizeUiCatalog({ caseStudies }, tMarketing, MARKETING_RELEASE_TRANSLATION_KEYS);
}
