/**
 * Case studies for the AI OS home page and /services: eight cards in one horizontal row. No
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
 *  - The hedge fund is Kortix's own desk (`kortix-ai/hedgefund`): real
 *    public SEC data, simulated capital and trades, a person at every gate.
 *    Always say it is ours and that the capital is simulated.
 *  - Every other case is a CLASS, never a name. Customer names are blocked
 *    commit terms (CLAUDE.md, `scripts/check-blocked-terms.sh`). Keep each
 *    class broad enough that it does not identify the company: no founding
 *    year, no office count, no city.
 *  - Only what the engagement really contains. No metric, no quote, no
 *    outcome number until the company signs one off.
 */

export type CaseStudy = {
  id: string;
  /** A third-party logo on a white tile, a drawn brand mark, or a Phosphor glyph. */
  logo?: { src: string; alt: string; width: number; height: number };
  mark?: 'kortix' | 'platinum';
  icon?: 'telecom' | 'search' | 'finance';
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
      logo: { src: '/media/case-studies/cityu.svg', alt: 'City University of Hong Kong', width: 262, height: 147 },
      category: 'Research',
      org: 'Hong Kong Institute of AI for Science, City University of Hong Kong',
      title: 'SciencePal: a science agent for researchers.',
      body: 'The institute’s AI research assistant, built from Kortix’s open-source code. It searches large literature databases and cites its sources, and it runs specialist agents for protein design and materials science, from property prediction to experiment design.',
      facts: [
        'Literature search with citations',
        'A protein design agent',
        'A materials science agent',
        'Built from Kortix’s open-source code',
      ],
    },
    {
      id: 'platinum',
      mark: 'platinum',
      category: 'Cloud infrastructure',
      org: 'Platinum',
      title: 'An autonomous cloud company.',
      body: 'Platinum is a sandbox cloud for AI agents, run by agents on Kortix. Engineering agents take Linear issues, build and test the change and open the pull request. QA agents drive the real dashboard, record every flow and report to Slack with the video. People set the direction and approve.',
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
      title: 'A whole company on one AI OS, in its own cloud.',
      body: 'The company runs Kortix self-hosted in its own cloud account. Every employee signs in with company SSO, and teams use company agents and internal apps built on Kortix, from a company-wide question-answering app to live dashboards.',
      facts: [
        'Self-hosted in its own cloud',
        'SSO and directory sync',
        'A company-wide Q&A app',
        'Internal apps and live dashboards',
      ],
    },
    {
      id: 'kortix',
      mark: 'kortix',
      category: 'Software',
      org: 'Kortix',
      title: 'Kortix, run on Kortix.',
      body: 'Our own company is one Kortix project. An intake agent triages every new issue and hands it to a worker agent, which fixes it on its own machine and opens the pull request. A compliance agency keeps our SOC 2 policies and evidence current. People review, approve and sign.',
      facts: [
        'Issues triaged by an intake agent',
        'Up to 16 worker agents at once',
        'SOC 2 policies kept current by agents',
        'Sales, support and marketing agents',
      ],
    },
    {
      id: 'hedge-fund',
      icon: 'finance',
      category: 'Finance',
      org: 'Built and run by Kortix',
      title: 'An AI-run hedge fund desk.',
      body: 'Our own structured-credit desk, on real public SEC data. Agents pull every new asset-backed deal from EDGAR, extract each figure with its page citation, argue the deal through six analyst lenses, red-team the verdict and draft the memo. A person decides at investment committee.',
      facts: [
        'New deals pulled from EDGAR',
        'Every figure cited to its page',
        'Six analyst lenses and a red team',
        'Real public data, simulated capital',
      ],
    },
    {
      id: 'executive-search',
      icon: 'search',
      category: 'Professional services',
      org: 'An international executive search firm',
      title: 'An executive search firm, rebuilt around agents.',
      body: 'A firm with four decades of history and offices on three continents, restructured to run on agents. Agents research candidates, prepare client and pitch materials, and run the firm’s internal operations.',
      facts: [
        'Candidate research agents',
        'Client and pitch materials',
        'Internal operations automated',
        'The whole firm on one AI OS',
      ],
    },
    {
      id: 'writer',
      logo: { src: '/media/case-studies/writer.svg', alt: 'WRITER', width: 110, height: 35 },
      category: 'Enterprise AI',
      org: 'WRITER',
      title: 'The enterprise AI platform, built from Kortix’s open-source code.',
      body: 'WRITER built its core agent platform from Kortix’s open-source code. Enterprises such as Salesforce, Vanguard, KPMG, Dropbox and H&R Block run their marketing, sales and support agents on WRITER.',
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
      body: 'Wring cuts its customers’ AWS bills with agents on Kortix. The agents find the AWS credit programs each customer qualifies for, prepare the applications and follow each one through to the decision. The customer approves, the agents do the paperwork.',
      facts: [
        'Credit programs found per customer',
        'Applications prepared by agents',
        'A person approves every submission',
        'Runs as one Kortix project',
      ],
    },
  ],
};
