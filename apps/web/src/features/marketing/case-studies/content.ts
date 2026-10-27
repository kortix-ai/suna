/**
 * Case studies for the AI OS home page and /services: four equal cards. No
 * card links anywhere, by founder decision.
 *
 * ACCURACY AND NAMING (read before editing):
 *  - HKAI-Sci / SciencePal is the one named case: founder decisions
 *    2026-10-22 and 2026-10-27 (the City University of Hong Kong logo, a
 *    description, no link). Facts: CityU press release 2025-11-05 (HKAI-Sci
 *    launched SciencePal: literature search with citations, protein design
 *    and materials science agents). Write "built from Kortix's open-source
 *    code", never "customer" or "partner": it is a product built from the
 *    open-source repo. The logo is CityU's trade mark (its logo/name policy):
 *    remove it on request.
 *  - The hedge fund is Kortix's own desk (`kortix-ai/hedgefund`): real
 *    public SEC data, simulated capital and trades, a person at every gate.
 *    Always say it is ours and that the capital is simulated.
 *  - Every other case is a CLASS, never a name. Customer names are blocked
 *    commit terms (CLAUDE.md, `scripts/check-blocked-terms.sh`). Keep each
 *    class broad enough that it does not identify the company: no founding
 *    year, no office count, no city.
 *  - Only what the engagement really contains. No metric, no quote, no
 *    outcome number until the customer signs one off.
 */

export type CaseStudy = {
  id: string;
  /** A third-party logo on a white tile, or a Phosphor glyph. */
  logo?: { src: string; alt: string; width: number; height: number };
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
      id: 'telecom',
      icon: 'telecom',
      category: 'Telecommunications',
      org: 'A leading US telecommunications infrastructure company',
      title: 'A whole company on one AI OS, in its own cloud.',
      body: 'The company runs Kortix self-hosted in its own cloud account. Every employee signs in with company SSO, and teams use company agents and internal apps built on Kortix, from a company-wide question-answering app to live dashboards.',
      facts: [
        'Self-hosted in its own cloud',
        'SSO and directory sync',
        'A company-wide question-answering app',
        'Internal apps and live dashboards',
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
  ],
};
