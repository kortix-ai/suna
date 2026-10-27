/**
 * Case studies for the AI OS home page and /services. Cards only: no card
 * links anywhere, by founder decision.
 *
 * ACCURACY AND NAMING (read before editing):
 *  - SciencePal is the one named case: founder decision 2026-10-22, its logo
 *    plus a description, no link. Facts: CityU press release 2025-11-05
 *    (HKAI-Sci launched SciencePal; literature search with citations; protein
 *    design and materials science agents). Write "built from Kortix's
 *    open-source code", never "a customer" or "partner": it is a product
 *    built from the open-source repo.
 *  - Every other case is a CLASS, never a name. Customer names are blocked
 *    commit terms (CLAUDE.md, `scripts/check-blocked-terms.sh`). Keep each
 *    class broad enough that it does not identify the company: no founding
 *    year, no office count, no city.
 *  - Only what the engagement really contains. No metric, no quote, no
 *    outcome number until the customer signs one off.
 */

export const caseStudies = {
  title: 'Case studies.',
  titleMuted: 'Running today.',
  featured: {
    id: 'sciencepal',
    logo: { src: '/media/case-studies/sciencepal.png', alt: 'SciencePal', width: 626, height: 123 },
    org: 'Hong Kong Institute of AI for Science, City University of Hong Kong',
    category: 'Research',
    title: 'A science agent for researchers, built from Kortix’s open-source code.',
    body: 'SciencePal is the AI research assistant of the Hong Kong Institute of AI for Science at City University of Hong Kong. It searches large literature databases and cites its sources, and it runs specialist agents for protein design and for materials science, from property prediction to experiment design.',
    facts: ['Literature search with citations', 'Protein design and materials science agents', 'Built from Kortix’s open-source code'],
  },
  items: [
    {
      id: 'telecom',
      icon: 'telecom',
      category: 'Telecommunications',
      title: 'A whole company on one AI OS, in its own cloud.',
      body: 'A leading US telecommunications infrastructure company runs Kortix self-hosted in its own cloud account. Every employee signs in with company SSO, and teams use company agents and internal apps built on Kortix, from a company-wide question-answering app to live dashboards.',
      facts: ['Self-hosted in its own cloud', 'SSO and directory sync', 'Internal apps and dashboards'],
    },
    {
      id: 'executive-search',
      icon: 'search',
      category: 'Professional services',
      title: 'An executive search firm, rebuilt around agents.',
      body: 'An international executive search firm with four decades of history and offices on three continents. Agents research candidates, prepare client and pitch materials, and run the firm’s internal operations.',
      facts: ['Candidate research agents', 'Client and pitch materials', 'Internal operations automated'],
    },
  ],
} as const;
