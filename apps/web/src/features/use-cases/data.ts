export const DEMO_VIDEO_ID = 'Eu5mYMavctM';

export type Agent = { name: string; description: string };
export type Industry = { name: string; description: string; agents: Agent[] };

export type UseCase = {
  id: string;
  slug: string;
  title: string;
  subtitle: string;
  category: string;
  tags: string[];
  prompt: string;
  videoId: string;
  proTip: string;
  metrics: string;
  integrations: string[];
  overview: string;
  inputs: string[];
  outputs: string[];
  steps: { title: string; description: string }[];
  posterKey: string;
};

export const INDUSTRIES: Industry[] = [
  {
    name: 'Software & SaaS',
    description:
      'Agents that live in your codebase, issue tracker, and support queue — shipping fixes, triaging bugs, and keeping docs honest.',
    agents: [
      { name: 'Bug triage', description: 'Reproduce, label, and route issues' },
      { name: 'PR review', description: 'First-pass review against your standards' },
      { name: 'Release notes', description: 'Draft changelogs from merged PRs' },
      { name: 'On-call assist', description: 'Summarize alerts and suggest a fix' },
      { name: 'Docs upkeep', description: 'Keep docs in sync with the code' },
      { name: 'Churn signals', description: 'Flag at-risk accounts from usage' },
      { name: 'Feature requests', description: 'Cluster feedback into themes' },
    ],
  },
  {
    name: 'E-commerce & Retail',
    description:
      'Agents across your storefront, catalog, and inbox — answering shoppers, fixing listings, and watching the numbers.',
    agents: [
      { name: 'Order support', description: 'Resolve where-is-my-order in seconds' },
      { name: 'Catalog cleanup', description: 'Fix titles, tags, and descriptions' },
      { name: 'Returns & refunds', description: 'Process within your policy' },
      { name: 'Pricing watch', description: 'Track competitors and margins' },
      { name: 'Review replies', description: 'Respond to reviews on brand' },
      { name: 'Restock alerts', description: 'Reorder before you sell out' },
      { name: 'Campaign recaps', description: 'Weekly performance, explained' },
    ],
  },
  {
    name: 'Marketing & Creative',
    description:
      'Agents that turn a brief into finished work — posts, pages, and assets, on brand and ready to ship.',
    agents: [
      { name: 'Content engine', description: 'Briefs into drafts and posts' },
      { name: 'SEO pages', description: 'Research, write, and interlink' },
      { name: 'Ad variations', description: 'On-brand copy and creative at scale' },
      { name: 'Social scheduling', description: 'Plan and post across channels' },
      { name: 'Campaign reporting', description: 'What worked, in plain English' },
      { name: 'Brand assets', description: 'Generate and edit visuals in-flow' },
    ],
  },
  {
    name: 'Sales & Revenue',
    description:
      'Agents that fill the pipeline and keep it clean — researching accounts, drafting outreach, and prepping every call.',
    agents: [
      { name: 'Lead research', description: 'Enrich and rank your accounts' },
      { name: 'Outreach drafts', description: 'Personalized, at scale' },
      { name: 'CRM hygiene', description: 'Keep records clean and current' },
      { name: 'Call prep', description: 'A brief before every meeting' },
      { name: 'Proposal drafts', description: 'Quotes and SOWs in minutes' },
      { name: 'Pipeline reports', description: 'Forecast and flag stalls' },
    ],
  },
  {
    name: 'Customer Support',
    description:
      'Agents on the front line — resolving tickets with full context, around the clock, and escalating only what matters.',
    agents: [
      { name: 'Ticket triage', description: 'Sort, tag, and route instantly' },
      { name: 'First response', description: 'Resolve common issues 24/7' },
      { name: 'Knowledge base', description: 'Draft and update help articles' },
      { name: 'Escalations', description: 'Hand off with full context' },
      { name: 'CSAT analysis', description: 'Spot themes in feedback' },
      { name: 'Saved replies', description: 'On-brand answers, every time' },
    ],
  },
  {
    name: 'Finance & Accounting',
    description:
      'Agents for the back office — reconciling, reporting, and closing the books with a trail you can audit.',
    agents: [
      { name: 'Invoice processing', description: 'Capture, match, and route' },
      { name: 'Reconciliation', description: 'Tie out accounts fast' },
      { name: 'Expense review', description: 'Flag policy exceptions' },
      { name: 'Board reporting', description: 'Consolidated and on time' },
      { name: 'Financial models', description: 'Forecasts and scenarios' },
      { name: 'AR follow-up', description: 'Chase invoices, politely' },
    ],
  },
  {
    name: 'People & Recruiting',
    description:
      'Agents for hiring and people ops — sourcing, screening, and onboarding handled, so your team can focus on people.',
    agents: [
      { name: 'Candidate sourcing', description: 'Find and rank matches' },
      { name: 'Resume screening', description: 'Shortlist against the role' },
      { name: 'Interview scheduling', description: 'Coordinate without the back-and-forth' },
      { name: 'Offer & onboarding', description: 'Draft offers, prep day one' },
      { name: 'HR answers', description: 'Answered from your handbook' },
      { name: 'Headcount reports', description: 'Pipeline and attrition' },
    ],
  },
  {
    name: 'Operations & Supply Chain',
    description:
      'Agents that keep the business running — turning orders, vendors, and SOPs into workflows that run themselves.',
    agents: [
      { name: 'Order tracking', description: 'Status across suppliers' },
      { name: 'Vendor management', description: 'Performance and contracts' },
      { name: 'Demand planning', description: 'Forecast and reorder' },
      { name: 'SOP automation', description: 'Turn playbooks into workflows' },
      { name: 'Quality checks', description: 'Log issues, open actions' },
      { name: 'Logistics', description: 'Shipments and exceptions' },
    ],
  },
  {
    name: 'Legal & Compliance',
    description:
      'Agents for review, research, and drafting — cited correctly, right for the jurisdiction, and reviewable end to end.',
    agents: [
      { name: 'Contract review', description: 'Your positions, their redlines' },
      { name: 'Legal research', description: 'Memos with citations' },
      { name: 'Document drafting', description: 'Briefs, motions, agreements' },
      { name: 'Diligence review', description: 'Transaction documents at speed' },
      { name: 'Policy tracking', description: 'Regulatory change, watched' },
      { name: 'E-discovery', description: 'Privilege and production prep' },
    ],
  },
  {
    name: 'Real Estate & Property',
    description:
      'Agents across listings, leads, and leases — drafting, qualifying, and keeping every deal moving.',
    agents: [
      { name: 'Listing copy', description: 'Photos and specs into listings' },
      { name: 'Lead qualification', description: 'Score and follow up fast' },
      { name: 'Comps & valuation', description: 'Pull comps, value a property' },
      { name: 'Lease abstraction', description: 'Key terms from any lease' },
      { name: 'Tenant requests', description: 'Triage and route maintenance' },
      { name: 'Closing checklist', description: 'Track docs to the finish' },
    ],
  },
];

export const FILTERS = ['All', ...INDUSTRIES.map((i) => i.name)];

export function slugify(value: string) {
  return value
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function slugFor(industry: string, agent: string) {
  return `${slugify(industry)}-${slugify(agent)}`;
}

export function agentMatchesQuery(industry: Industry, agent: Agent, words: string[]) {
  const haystack = [industry.name, industry.description, agent.name, agent.description].map((s) =>
    s.toLowerCase(),
  );
  return words.every((word) => haystack.some((text) => text.includes(word)));
}

const POSTERS = [
  '/showcase/data/dashboard.png',
  '/showcase/presentation/slide1.png',
  '/images/landing-showcase/data.png',
  '/images/landing-showcase/docs.png',
  '/images/landing-showcase/research.png',
  '/images/landing-showcase/slides.png',
  '/images/landing-showcase/images.png',
];

export function posterFor(key: string) {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return POSTERS[h % POSTERS.length];
}

export const favicon = (domain: string) =>
  `https://www.google.com/s2/favicons?domain=${domain}&sz=128`;

export function integrationLabel(domain: string) {
  return domain.replace(/\.(com|so|google\.com|app)$/, '').replace('drive.', 'Drive');
}

function buildUseCase(agent: Agent, industry: string): UseCase {
  const lc = agent.description.charAt(0).toLowerCase() + agent.description.slice(1);
  const lname = agent.name.toLowerCase();
  return {
    id: slugFor(industry, agent.name),
    slug: slugFor(industry, agent.name),
    title: agent.name,
    subtitle: agent.description,
    category: industry,
    tags: ['Hours, not weeks', 'Fully traceable', 'On your standards'],
    prompt: `${agent.description} for our ${industry.toLowerCase()} team, and prepare it for review.`,
    videoId: DEMO_VIDEO_ID,
    proTip: `Start narrow: point the ${lname} agent at one ${industry.toLowerCase()} workflow, review its first few runs, then let it run on a schedule.`,
    metrics: `Teams running the ${lname} agent finish in hours what used to take days — with a full audit trail on every run.`,
    integrations: ['gmail.com', 'slack.com', 'drive.google.com', 'github.com', 'notion.so'],
    overview: `The ${agent.name} agent handles ${lc} for ${industry} teams — end to end. It pulls context from your connected systems, plans the work, executes across your tools in a secure sandbox, and returns a finished, reviewable deliverable. It runs on a schedule or on demand, and gets sharper with every run.`,
    inputs: [
      'Your connected data & documents',
      'Existing templates & standards',
      'A goal in plain language',
    ],
    outputs: [
      `A finished ${lname} deliverable`,
      'A reviewable run log with sources',
      'A reusable skill saved to your repo',
    ],
    steps: [
      {
        title: 'Connect the context',
        description: `Pulls the data, documents, and tools the ${lname} workflow depends on — with permissioned access only.`,
      },
      {
        title: 'Plan the work',
        description:
          'Breaks the goal into a verifiable task list and selects the right skills and tools.',
      },
      {
        title: 'Execute in a sandbox',
        description:
          'Works across your systems in an isolated environment, with every action logged.',
      },
      {
        title: 'Return for review',
        description:
          'Hands back a finished deliverable with a traceable trail; a human approves before anything ships.',
      },
    ],
    posterKey: industry + agent.name,
  };
}

export function getAllUseCases(): UseCase[] {
  return INDUSTRIES.flatMap((industry) =>
    industry.agents.map((agent) => buildUseCase(agent, industry.name)),
  );
}

export function getUseCaseBySlug(slug: string): UseCase | undefined {
  for (const industry of INDUSTRIES) {
    for (const agent of industry.agents) {
      if (slugFor(industry.name, agent.name) === slug) {
        return buildUseCase(agent, industry.name);
      }
    }
  }
  return undefined;
}
