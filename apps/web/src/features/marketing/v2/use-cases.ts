export type UseCase = {
  slug: string;
  name: string;
  teaser: string;
  heading: string[];
  body: string;
  steps: { name: string; description: string }[];
  outcomes: string[];
};

export const USE_CASES: UseCase[] = [
  {
    slug: 'change-review',
    name: 'Change review',
    teaser: 'Every open change request read, risk-flagged, and commented before a human opens it.',
    heading: ['Review every change', 'before anyone opens it.'],
    body: 'A review agent picks up each open change request, reads the diff against the surrounding code and the decisions already in memory, and leaves a structured comment: what changed, what it touches, and what looks risky.',
    steps: [
      {
        name: 'Trigger',
        description: 'A webhook fires the moment a change request opens.',
      },
      {
        name: 'Context',
        description:
          'The session pulls the diff, the linked ticket, and the relevant files from memory.',
      },
      {
        name: 'Review',
        description: 'It flags risk, missing tests, and anything that contradicts a past decision.',
      },
      {
        name: 'Comment',
        description: 'The findings land on the change request, where your reviewers already are.',
      },
    ],
    outcomes: [
      'Reviewers start from a summary, not a blank diff',
      'Risky changes are flagged before the first human look',
      'Past decisions get enforced instead of forgotten',
    ],
  },
  {
    slug: 'company-digest',
    name: 'Company digest',
    teaser: 'The weekly business summary, drawn from your own data instead of retyped by hand.',
    heading: ['The weekly digest,', 'written from the source.'],
    body: 'A go-to-market agent reads the CRM, the payment data, the support inbox, and the merged change requests, then writes the summary your team currently assembles by hand every Monday morning.',
    steps: [
      { name: 'Trigger', description: 'A cron entry in kortix.yaml fires at 08:00 on Mondays.' },
      {
        name: 'Context',
        description: 'Connectors pull revenue, pipeline, support volume, and shipped work.',
      },
      { name: 'Draft', description: 'The agent writes the digest using your own house style.' },
      {
        name: 'Deliver',
        description: 'It posts to your channel and opens a change request against the archive.',
      },
    ],
    outcomes: [
      'The same summary, every week, without a reminder',
      'Numbers come from the source, not a screenshot',
      'Last week is always one file away',
    ],
  },
  {
    slug: 'support-triage',
    name: 'Support triage',
    teaser: 'The inbox read, grouped, and answered from your own documentation.',
    heading: ['Triage the inbox', 'before your team opens it.'],
    body: 'A support agent reads incoming threads, groups them by theme, drafts answers grounded in your documentation, and escalates the ones that need a person — with the context already gathered.',
    steps: [
      { name: 'Trigger', description: 'New threads arrive over a channel or a webhook.' },
      {
        name: 'Context',
        description: 'The session reads your docs, past resolutions, and the account history.',
      },
      { name: 'Draft', description: 'It writes an answer and cites what it drew from.' },
      {
        name: 'Escalate',
        description: 'Anything ambiguous goes to a person with the research attached.',
      },
    ],
    outcomes: [
      'First response goes out in minutes, not hours',
      'Answers stay consistent with the documentation',
      'Escalations arrive with the work already done',
    ],
  },
];

export const bySlug = (slug: string) => USE_CASES.find((u) => u.slug === slug);
