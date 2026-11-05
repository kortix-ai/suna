import { MARKETING_RELEASE_TRANSLATION_KEYS } from '@/i18n/marketing-release-translation-keys.generated';
import { localizeUiCatalog } from '@kortix/ui/i18n';
/**
 * Case studies for the CompanyOS home page, /services and /case-studies: one
 * horizontal row (a grid on /case-studies). No card links anywhere, by founder
 * decision. A card shows its category, never the client's name (founder,
 * 2026-11-02). `hidden: true` keeps a card's copy here without showing it.
 * The cards show in the order of `items`, the same on every load; the
 * science agent is always first (founder, 2026-11-02).
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
 *  - The asset manager card shows only the analysis: every deal evaluated
 *    end to end (founder, 2026-11-03), in general terms (2026-11-02: no "own fund", no
 *    "simulated capital"). Its source is Kortix's own fund project
 *    (`kortix-ai/hedgefund`, CASE-STUDY.md): real public market data,
 *    simulated investors, capital and trades. Name only steps that project
 *    runs, and never a fund size, a return or a client.
 *  - Each card shows one autonomous job, never the whole company (founder,
 *    2026-11-03): its title names that job, its body and facts stay on it.
 *    Bodies stay minimal (2026-11-02): one or two short sentences on what
 *    the agents do there and who decides. Only the WRITER card says "built from
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
 *  - Every logo `src` ends in `?v=` and the first 8 hex of the file's sha256:
 *    the files are cached for a day, so a redrawn file needs a new URL.
 *  - Only what the engagement really contains. No metric, no quote, no
 *    outcome number until the company signs one off.
 *  - Banking, insurance, airlines, healthcare and retail are
 *    industry lifecycle cards (founder, 2026-11-02), modelled on the
 *    per-industry lifecycles enterprise AI vendors publish: each walks one
 *    lifecycle end to end and names the person who approves. They name no
 *    client and carry no metric or quote. Their marks are drawn by Kortix;
 *    some carry invented letters (N, Ry, H, m, ro), never a real client's
 *    initials.
 *  - The asset manager and executive search logos are symbols Kortix drew
 *    for these cards (founder, 2026-11-02; brand decision D36): no type at
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
  titleMuted: 'What runs on CompanyOS.',
  items: [
    {
      id: 'hkai-sci',
      logo: {
        src: '/media/case-studies/cityu.svg?v=185a2ee8',
        alt: 'City University of Hong Kong',
        width: 262,
        height: 147,
      },
      category: 'Research',
      title: 'A science agent for researchers.',
      body: 'The institute’s AI research assistant. It searches the scientific literature with citations and runs agents for protein design and materials science.',
      facts: [
        'Literature search with citations',
        'A protein design agent',
        'A materials science agent',
        'Property prediction to experiment design',
      ],
    },
    {
      id: 'telecom',
      logo: {
        src: '/media/case-studies/telecom.svg?v=3241cd3d',
        alt: 'A leading US telecommunications infrastructure company',
        width: 246,
        height: 278,
      },
      category: 'Telecommunications',
      title: 'Autonomous fiber network design.',
      body: 'Agents design fiber routes from GIS data and imagery and build the bill of materials for each route.',
      facts: [
        'Fiber routes designed from GIS and imagery',
        'Bills of materials from GIS layers',
        'Self-hosted in its own cloud',
        'Single sign-on',
      ],
    },
    {
      id: 'asset-management',
      logo: {
        src: '/media/case-studies/asset-management.svg?v=54485925',
        alt: 'An asset management symbol',
        width: 100,
        height: 100,
      },
      category: 'Asset management',
      title: 'Every deal, evaluated by agents.',
      body: 'Every deal that comes in gets a full analysis. Agents screen it against the mandate, read the filings and market data, stress-test the thesis and the downside, and write the investment memo. The investment committee decides.',
      facts: [
        'Every deal screened against the mandate',
        'Filings and market data read',
        'Thesis and downside stress-tested',
        'An investment memo for every deal',
      ],
    },
    {
      id: 'platinum',
      mark: 'platinum',
      category: 'Cloud infrastructure',
      title: 'Autonomous software engineering.',
      body: 'Engineering agents pick up issues, write the code and test every flow on video. People approve what ships.',
      facts: [
        'Engineering agents ship from Linear issues',
        'QA agents test every flow on video',
        'Agents work in parallel',
        'People approve what ships',
      ],
    },
    {
      id: 'banking',
      logo: {
        src: '/media/case-studies/banking.svg?v=02ed3983',
        alt: 'A banking mark',
        width: 100,
        height: 100,
      },
      category: 'Banking',
      title: 'Autonomous credit analysis.',
      body: 'Agents spread the financials, check them against the bank’s credit policy and write the credit memo. A credit officer decides.',
      facts: [
        'Financial statements spread',
        'Checked against credit policy',
        'A credit memo with every source',
        'A credit officer decides',
      ],
    },
    {
      id: 'executive-search',
      logo: {
        src: '/media/case-studies/executive-search.svg?v=ea5988cb',
        alt: 'An international executive search firm',
        width: 100,
        height: 100,
      },
      category: 'Professional services',
      title: 'Autonomous candidate research.',
      body: 'Agents research candidates for every search and write a profile of each one. Consultants choose the shortlist.',
      facts: [
        'Candidate research agents',
        'A profile for every candidate',
        'Research for every search',
        'Consultants choose the shortlist',
      ],
    },
    {
      id: 'wring',
      logo: {
        src: '/media/case-studies/wring.svg?v=2a1cb9ad',
        alt: 'Wring',
        width: 74,
        height: 28,
      },
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
      id: 'retail',
      logo: {
        src: '/media/case-studies/retail.svg?v=32ec4d76',
        alt: 'A retail symbol',
        width: 100,
        height: 100,
      },
      category: 'Retail',
      title: 'Autonomous invoice matching.',
      body: 'Agents match every supplier invoice to its order and receipt and chase each discrepancy. People approve amounts above a limit.',
      facts: [
        'Invoices matched to orders and receipts',
        'Discrepancies chased with suppliers',
        'Every match with its documents',
        'Approval above a set limit',
      ],
    },
    {
      id: 'insurance',
      hidden: true,
      logo: {
        src: '/media/case-studies/insurance.svg?v=430db859',
        alt: 'An insurance mark',
        width: 100,
        height: 100,
      },
      category: 'Insurance',
      title: 'Claims, from first notice to payout.',
      body: 'Agents take the first notice of loss, check coverage, validate the claim, flag fraud and draft the settlement. An adjuster approves the payout.',
      facts: [
        'First notice of loss intake',
        'Coverage checked against the policy',
        'Fraud signals flagged',
        'Settlement drafted for approval',
      ],
    },
    {
      id: 'airlines',
      hidden: true,
      logo: {
        src: '/media/case-studies/airlines.svg?v=92d4c4af',
        alt: 'An airline symbol',
        width: 100,
        height: 100,
      },
      category: 'Airlines',
      title: 'Disruptions and EU261 claims, end to end.',
      body: 'Agents rebook passengers in a disruption, check each EU261 claim against the flight record and draft the payment or the answer. People approve large payouts.',
      facts: [
        'Rebooking during disruptions',
        'Claims checked against flight data',
        'EU261 rules applied per claim',
        'An audit trail for the regulator',
      ],
    },
    {
      id: 'healthcare',
      hidden: true,
      logo: {
        src: '/media/case-studies/healthcare.svg?v=35ab0f7e',
        alt: 'A healthcare symbol',
        width: 100,
        height: 100,
      },
      category: 'Healthcare',
      title: 'Prior authorization, without the paperwork.',
      body: 'Agents read the chart, match it to the payer’s rules, assemble the request and track it to a decision. A clinician signs every request.',
      facts: [
        'A chart summary per request',
        'Payer rules matched per procedure',
        'Requests tracked to a decision',
        'A clinician signs every request',
      ],
    },
    {
      id: 'kortix',
      hidden: true,
      mark: 'kortix',
      category: 'Software',
      title: 'Kortix, run on Kortix.',
      body: 'Our company is one Kortix workspace. Agents triage and fix issues, keep SOC 2 evidence current and run sales and support. People approve.',
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
      logo: {
        src: '/media/case-studies/writer.svg?v=521311b7',
        alt: 'WRITER',
        width: 110,
        height: 35,
      },
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
