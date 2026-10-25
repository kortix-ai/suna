/**
 * Every word on the public site, in one place. Lumen is a reference product:
 * firms, people and stories are fictional, and a site-wide line says so. Every
 * number is measured on Lumen's own evaluation set (agent-kit/evals, README
 * "Workflows on real sessions"); no number is invented.
 */

export type ProductSlug = 'assistant' | 'vault' | 'review' | 'workflows' | 'drafting' | 'oversight';
export type MockName =
  | 'composer'
  | 'answer'
  | 'vault'
  | 'versions'
  | 'review'
  | 'cell'
  | 'workflowList'
  | 'playbook'
  | 'diligence'
  | 'redline'
  | 'draft'
  | 'oversight'
  | 'audit'
  | 'roles'
  | 'matter'
  | 'sandbox'
  | 'schedule'
  | 'question';

export interface Feature {
  title: string;
  body: string;
  mock: MockName;
}

export interface Product {
  slug: ProductSlug;
  /** The single noun in the nav and the mega-menu. */
  name: string;
  /** Hero headline, two short lines. */
  title: string;
  lead: string;
  /** The one-line summary on the overview page. */
  summary: string;
  heroMock: MockName;
  /** The centred title above the feature rows. */
  sectionTitle: string;
  features: Feature[];
}

export const PRODUCTS: Product[] = [
  {
    slug: 'assistant',
    name: 'Assistant',
    title: 'Ask the matter. Get the clause.',
    lead: 'Questions are answered from the documents in the matter. Every claim carries a numbered citation that opens the page and the quoted words.',
    summary: 'Cited answers from the documents in the matter, with the page one click away.',
    heroMock: 'composer',
    sectionTitle: 'An assistant that shows its work',
    features: [
      {
        title: 'Every answer cited',
        body: 'Each claim links to the paragraph it came from. Lumen checks every quote against the source before it draws the chip, and labels a miss instead of hiding it.',
        mock: 'answer',
      },
      {
        title: 'Workflows with a slash',
        body: 'Type / in the composer to run a firm workflow on the matter: an NDA review, a chronology, a diligence memo. Your own workflows appear next to Lumen’s.',
        mock: 'composer',
      },
      {
        title: 'It asks before it guesses',
        body: 'When a question turns on a fact the documents do not settle, such as which side you act for, Lumen asks and waits for your answer.',
        mock: 'question',
      },
      {
        title: 'Real work, not just text',
        body: 'Each conversation runs in its own isolated workspace with real tools. Lumen can OCR a scan, compare two versions, compute a notice period or build an exhibit list.',
        mock: 'sandbox',
      },
    ],
  },
  {
    slug: 'vault',
    name: 'Vault',
    title: 'Every document, read page by page.',
    lead: 'Drop in a data room of PDFs and Word files. Lumen reads each page, keeps every version and finds the passage, not just the file.',
    summary: 'A matter’s documents, versioned and searchable down to the paragraph.',
    heroMock: 'vault',
    sectionTitle: 'One place for the whole matter',
    features: [
      {
        title: 'Search inside every page',
        body: 'Search finds the passage across the matter and opens the preview at the right page, with the words marked.',
        mock: 'vault',
      },
      {
        title: 'Versions you can trust',
        body: 'Upload a new turn of a contract and Lumen keeps the old one. Citations stay bound to the version they quote.',
        mock: 'versions',
      },
      {
        title: 'Built for the data room',
        body: 'Upload dozens of files at once. Duplicates are caught by content, and each file is ready to cite in seconds.',
        mock: 'matter',
      },
    ],
  },
  {
    slug: 'review',
    name: 'Review',
    title: 'A data room, as a table.',
    lead: 'Each row is a document and each column a question: liability cap, governing law, change of control. Lawyers verify, flag or edit every cell.',
    summary: 'Tabular review: documents as rows, questions as columns, every cell cited.',
    heroMock: 'review',
    sectionTitle: 'The diligence grid, done for you',
    features: [
      {
        title: 'Columns from a question',
        body: 'Pick a column from the clause library or write the question yourself. Choose the answer type: text, yes or no, date, amount, list or tag.',
        mock: 'review',
      },
      {
        title: 'Every cell, sourced',
        body: 'Open a cell to read the answer, the reasoning and the quote. A verified cell keeps its value when the column runs again.',
        mock: 'cell',
      },
      {
        title: 'Out to Excel',
        body: 'Export the grid to Excel or CSV with the citations alongside each value, ready for the diligence report.',
        mock: 'review',
      },
    ],
  },
  {
    slug: 'workflows',
    name: 'Workflows',
    title: 'Your playbook, applied clause by clause.',
    lead: 'Review a contract against the firm’s positions, run diligence over a data room, or draft from a precedent. Build your own and share them with the firm.',
    summary: 'Playbook review, diligence and drafting, plus the workflows your firm builds.',
    heroMock: 'workflowList',
    sectionTitle: 'Repeatable work, run the firm’s way',
    features: [
      {
        title: 'Contract review against your playbook',
        body: 'Lumen checks each rule, rates the deviation and proposes a redline. The redline arrives as tracked changes in Word.',
        mock: 'playbook',
      },
      {
        title: 'Due diligence over the whole room',
        body: 'Long runs fan out across documents in parallel, then come back as one report with every red flag cited.',
        mock: 'diligence',
      },
      {
        title: 'Workflows the firm owns',
        body: 'Write an assistant workflow as instructions, or a review workflow as a set of columns. Keep it private or share it with the firm.',
        mock: 'workflowList',
      },
      {
        title: 'Runs on a schedule',
        body: 'Run a review when new documents arrive, or a weekly obligations check on a live matter.',
        mock: 'schedule',
      },
    ],
  },
  {
    slug: 'drafting',
    name: 'Drafting',
    title: 'Drafts that start from your precedent.',
    lead: 'Fill a firm template from the matter, propose changes as tracked edits and leave every fact it cannot confirm marked for a lawyer.',
    summary: 'Templates filled from the matter, edits as tracked changes in Word.',
    heroMock: 'draft',
    sectionTitle: 'From precedent to first draft',
    features: [
      {
        title: 'Templates, filled from the matter',
        body: 'Pick a firm template and the parties, dates and terms come from the documents. A fact Lumen cannot confirm stays marked, never invented.',
        mock: 'draft',
      },
      {
        title: 'Redlines in Word',
        body: 'Proposed changes arrive as real tracked insertions, deletions and comments, so the other side sees a normal Word turn.',
        mock: 'redline',
      },
      {
        title: 'Every draft lands in the matter',
        body: 'A generated file is saved to the Vault as a new document, ready to cite, review or send.',
        mock: 'versions',
      },
    ],
  },
  {
    slug: 'oversight',
    name: 'Oversight',
    title: 'Control every matter, member and run.',
    lead: 'Roles, restricted matters, an audit log nobody can edit and usage by matter and member: the controls a managing partner asks for first.',
    summary: 'Roles, restricted matters, the audit log and usage, in one place.',
    heroMock: 'oversight',
    sectionTitle: 'Governed from day one',
    features: [
      {
        title: 'Roles and restricted matters',
        body: 'Owners and admins run the firm. Lawyers see the matters they work on. A restricted matter is open only to the people on it.',
        mock: 'roles',
      },
      {
        title: 'An audit log you cannot edit',
        body: 'Every change is recorded: members, matters, runs, exports and billing. Filter it, export it, never delete it.',
        mock: 'audit',
      },
      {
        title: 'Usage by matter and member',
        body: 'See which matters and which people use Lumen, and how much, before the invoice does.',
        mock: 'oversight',
      },
    ],
  },
];

export const productBySlug = (slug: string) => PRODUCTS.find((p) => p.slug === slug);

export type SolutionSlug = 'law-firms' | 'in-house' | 'litigation' | 'transactions';

export interface Solution {
  slug: SolutionSlug;
  name: string;
  eyebrow: string;
  title: string;
  lead: string;
  rows: { label: string; title: string; body: string; mock: MockName }[];
  workflows: string[];
}

export const SOLUTIONS: Solution[] = [
  {
    slug: 'law-firms',
    name: 'Law firms',
    eyebrow: 'Lumen for law firms',
    title: 'More matters. Same partners.',
    lead: 'Give every associate a second reader that cites its sources, and every partner a record of what was checked.',
    rows: [
      { label: 'Review', title: 'First pass in minutes, not days', body: 'Run the diligence grid across a data room before the kick-off call ends.', mock: 'review' },
      { label: 'Precedent', title: 'The firm’s positions, applied every time', body: 'Playbooks and templates live in the firm Library and every workflow uses them.', mock: 'playbook' },
      { label: 'Control', title: 'Walls where the work needs them', body: 'Restricted matters and an append-only audit log for conflict-sensitive work.', mock: 'roles' },
    ],
    workflows: ['Contract review against a playbook', 'Due diligence report', 'Draft from template', 'Chronology from a bundle', 'Issues list'],
  },
  {
    slug: 'in-house',
    name: 'In-house',
    eyebrow: 'Lumen for in-house teams',
    title: 'Clear the queue. Keep the judgment.',
    lead: 'Turn the NDA and vendor-contract queue into a same-day service, with your positions applied and every deviation explained.',
    rows: [
      { label: 'Intake', title: 'Every contract reviewed the same way', body: 'Your playbook flags each deviation, with a proposed redline and the reason.', mock: 'playbook' },
      { label: 'Portfolio', title: 'Know what you signed', body: 'Ask across every agreement: which renew this quarter, which are uncapped, which need consent to assign.', mock: 'answer' },
      { label: 'Business', title: 'Answers the business can act on', body: 'Short cited answers your colleagues can check themselves.', mock: 'composer' },
    ],
    workflows: ['NDA triage', 'Vendor contract review', 'Renewal and notice tracker', 'Policy Q&A', 'Obligations register'],
  },
  {
    slug: 'litigation',
    name: 'Litigation',
    eyebrow: 'Lumen for litigation',
    title: 'Every fact, back to the page.',
    lead: 'Build chronologies, issue lists and witness outlines from the bundle, with a citation on every line.',
    rows: [
      { label: 'Bundle', title: 'Chronology from a thousand pages', body: 'Dates, events and actors, each linked to the page it came from.', mock: 'diligence' },
      { label: 'Research', title: 'Ask the record', body: 'Who knew what, and when. Answers quote the exhibit and the paragraph.', mock: 'answer' },
      { label: 'Drafting', title: 'Outlines that start from the evidence', body: 'Draft a witness outline or a letter before action from the matter documents.', mock: 'draft' },
    ],
    workflows: ['Chronology', 'Issues list', 'Witness outline', 'Disclosure review', 'Letter before action'],
  },
  {
    slug: 'transactions',
    name: 'Transactions',
    eyebrow: 'Lumen for M&A and finance',
    title: 'The data room, read before the call.',
    lead: 'Diligence across every agreement, a red-flag report that cites each finding, and a disclosure schedule that starts itself.',
    rows: [
      { label: 'Diligence', title: 'Red flags, ranked and cited', body: 'Change of control, assignment, exclusivity and uncapped liability, across the room.', mock: 'diligence' },
      { label: 'Grid', title: 'The review table, filled', body: 'Every agreement against every question, ready to verify and export.', mock: 'review' },
      { label: 'Signing', title: 'From term sheet to first draft', body: 'Populate the SPA or the ancillaries from the agreed terms.', mock: 'draft' },
    ],
    workflows: ['Due diligence report', 'Change of control sweep', 'Disclosure schedule', 'CP checklist', 'Draft from term sheet'],
  },
];

export const solutionBySlug = (slug: string) => SOLUTIONS.find((s) => s.slug === slug);

/** Fictional firms for the logo wall and stories. Each is drawn as a type-only lockup. */
export const FIRMS = [
  { name: 'Alder & Finch', style: 'serif' },
  { name: 'BIRCH PARTNERS', style: 'caps' },
  { name: 'Calder Row', style: 'sans' },
  { name: 'Dunmore LLP', style: 'serif-italic' },
  { name: 'EASTWICK', style: 'wide' },
  { name: 'Fenwick Lane', style: 'sans-bold' },
  { name: 'Greyfriars', style: 'serif' },
  { name: 'HOLLIS & VANE', style: 'caps' },
  { name: 'Ivesmoor', style: 'sans' },
  { name: 'Juniper Legal', style: 'serif-italic' },
  { name: 'KESTREL', style: 'wide' },
  { name: 'Larchmont', style: 'sans-bold' },
] as const;

export type FirmStyle = (typeof FIRMS)[number]['style'];

export interface Story {
  slug: string;
  firm: string;
  style: FirmStyle;
  title: string;
  quote: string;
  person: string;
  role: string;
  meta: { label: string; value: string }[];
  /** Hue of the abstract photograph behind the lockup. */
  tone: 'stone' | 'night' | 'ember' | 'moss';
  body: { heading: string; paragraphs: string[] }[];
}

export const STORIES: Story[] = [
  {
    slug: 'alder-finch',
    firm: 'Alder & Finch',
    style: 'serif',
    title: 'How Alder & Finch reads a data room before the kick-off call',
    quote:
      'The first pass used to take a team of four the best part of a week. Now the grid is waiting for us at the kick-off, and we spend the week on the parts that need a lawyer.',
    person: 'Head of Corporate',
    role: 'Alder & Finch (fictional)',
    tone: 'night',
    meta: [
      { label: 'Firm', value: 'Alder & Finch' },
      { label: 'Practice', value: 'Corporate and M&A' },
      { label: 'Size', value: '11–50 lawyers' },
      { label: 'Uses', value: 'Review, Diligence, Vault' },
    ],
    body: [
      {
        heading: 'The problem',
        paragraphs: [
          'Mid-market deals arrive with data rooms of a few hundred agreements and a timetable set by the client. The first pass, reading every agreement for change of control, assignment and liability, decided how much of the week was left for advice.',
        ],
      },
      {
        heading: 'What changed',
        paragraphs: [
          'The team now uploads the room to a matter on day one and runs the firm’s diligence workflow overnight. Each red flag in the report links to the clause, so the associate checking it opens the page instead of searching for it.',
          'Cells a lawyer has verified keep their value when a column runs again, so the grid improves as the deal does, without anyone losing work.',
        ],
      },
      {
        heading: 'How they check it',
        paragraphs: [
          'Every quote in an answer is checked against the source before it reaches the screen. A quote Lumen cannot find is shown as unverified, never as fact. The partners read the audit log, not the associates’ notes, to see what was checked.',
        ],
      },
    ],
  },
  {
    slug: 'birch-partners',
    firm: 'BIRCH PARTNERS',
    style: 'caps',
    title: 'Birch Partners applies one playbook to every NDA',
    quote: 'Our playbook used to live in a partner’s head. Now it is a document the whole team edits, and every review uses this week’s version of it.',
    person: 'Knowledge Lawyer',
    role: 'Birch Partners (fictional)',
    tone: 'stone',
    meta: [
      { label: 'Firm', value: 'Birch Partners' },
      { label: 'Practice', value: 'Commercial' },
      { label: 'Size', value: '2–10 lawyers' },
      { label: 'Uses', value: 'Contract review, Library' },
    ],
    body: [
      {
        heading: 'The problem',
        paragraphs: ['Small teams review the same kinds of contract every week, and each lawyer applied the firm’s positions slightly differently.'],
      },
      {
        heading: 'What changed',
        paragraphs: [
          'The firm’s positions now sit in one playbook in the Library. Contract review checks each rule, rates the deviation and proposes the redline. When the firm changes a position, the next review uses it.',
        ],
      },
    ],
  },
  {
    slug: 'calder-row',
    firm: 'Calder Row',
    style: 'sans',
    title: 'Calder Row builds chronologies with a citation on every line',
    quote: 'A chronology is only as good as its references. Every line now points to the page, so the bundle index writes itself.',
    person: 'Senior Associate, Disputes',
    role: 'Calder Row (fictional)',
    tone: 'ember',
    meta: [
      { label: 'Firm', value: 'Calder Row' },
      { label: 'Practice', value: 'Disputes' },
      { label: 'Size', value: '51+ lawyers' },
      { label: 'Uses', value: 'Assistant, Workflows' },
    ],
    body: [
      {
        heading: 'The problem',
        paragraphs: ['Disclosure bundles run to thousands of pages, and every fact in a chronology needs a page reference that survives cross-examination.'],
      },
      {
        heading: 'What changed',
        paragraphs: ['The team runs a chronology workflow over the bundle. Each entry carries the date, the actors and a citation that opens the page, and the lawyer verifies the entries that matter.'],
      },
    ],
  },
  {
    slug: 'dunmore',
    firm: 'Dunmore LLP',
    style: 'serif-italic',
    title: 'Dunmore’s in-house clients get same-day answers',
    quote: 'Clients ask which contracts renew this quarter. We answer the same afternoon, with the clause attached.',
    person: 'Partner, Commercial',
    role: 'Dunmore LLP (fictional)',
    tone: 'moss',
    meta: [
      { label: 'Firm', value: 'Dunmore LLP' },
      { label: 'Practice', value: 'Commercial and in-house support' },
      { label: 'Size', value: '11–50 lawyers' },
      { label: 'Uses', value: 'Assistant, Review' },
    ],
    body: [
      {
        heading: 'What changed',
        paragraphs: ['Portfolio questions that used to need a spreadsheet project are now a review with five columns, exported to Excel with the citations beside each value.'],
      },
    ],
  },
];

export const storyBySlug = (slug: string) => STORIES.find((s) => s.slug === slug);

/** Measured results, from Lumen's own evaluation runs (README, agent-kit/evals). */
export const RESULTS = [
  { value: '168', unit: '/168', caption: 'quotes found at the cited paragraph in the agent kit 1.3.1 evaluation run' },
  { value: '4', unit: '/4', caption: 'planted red flags found and cited in a six-document diligence run' },
  { value: '66', unit: 's', caption: 'to fill and cite 48 review cells: six agreements by eight questions' },
];

export const SECURITY_PRINCIPLES = [
  { icon: 'lock', title: 'Each firm, its own workspace', body: 'Documents, conversations and results belong to the firm that created them. Another firm cannot mount, list or read them.' },
  { icon: 'cube', title: 'Isolated per task', body: 'Every conversation and every run works in its own isolated environment, created for it and closed after it.' },
  { icon: 'quotes', title: 'Citations checked', body: 'Lumen checks every quote against the source before it is shown, and marks the ones it cannot find.' },
  { icon: 'users', title: 'Roles and walls', body: 'Owners, admins and lawyers. A restricted matter is visible only to the people added to it.' },
  { icon: 'list', title: 'An audit log nobody edits', body: 'Members, matters, runs, exports and billing are recorded. Entries cannot be changed or deleted.' },
  { icon: 'key', title: 'Credentials stay on the server', body: 'Members reach the agent workspace only through Lumen’s server. The firm’s credentials never leave it, and every request is checked against the member’s access to the matter.' },
] as const;

export const NEWS = [
  { title: 'Lumen 1.3: new firms onboard in seconds', date: 'Oct 21, 2026', tag: 'Product', slug: 'lumen-1-3' },
  { title: 'How Lumen checks a citation before you see it', date: 'Oct 14, 2026', tag: 'Engineering', slug: 'how-lumen-checks-a-citation' },
  { title: 'Tabular review gets typed columns and Excel export', date: 'Oct 2, 2026', tag: 'Product', slug: 'typed-columns' },
  { title: 'Playbooks: one source of truth for the firm’s positions', date: 'Sep 18, 2026', tag: 'Product', slug: 'playbooks' },
  { title: 'Why every Lumen task runs in its own workspace', date: 'Sep 4, 2026', tag: 'Security', slug: 'isolated-workspaces' },
  { title: 'Designing for a lawyer who checks the source', date: 'Aug 21, 2026', tag: 'Design', slug: 'designing-for-the-source' },
];

export interface Post {
  slug: string;
  title: string;
  date: string;
  tag: string;
  lead: string;
  sections: { heading: string; paragraphs: string[] }[];
}

/** Long-form posts. Each states only what the product does. */
export const POSTS: Post[] = [
  {
    slug: 'how-lumen-checks-a-citation',
    title: 'How Lumen checks a citation before you see it',
    date: 'Oct 14, 2026',
    tag: 'Engineering',
    lead: 'A citation is a promise: these words are on this page. Lumen keeps the promise by checking every quote against its own index of the document before the chip is drawn.',
    sections: [
      {
        heading: 'Every document becomes numbered paragraphs',
        paragraphs: [
          'When a document reaches the Vault, Lumen reads it page by page and splits each page into paragraphs with a stable number. The agent cites a paragraph by that number and quotes the words it relied on.',
        ],
      },
      {
        heading: 'The quote is checked, not trusted',
        paragraphs: [
          'Before an answer reaches the screen, Lumen looks for the quoted words in the cited paragraph. If they are there, the chip is verified. If they are in a nearby paragraph, the citation is moved there and marked as relocated. If they are nowhere in the document, the chip is struck through and labelled unverified.',
          'On the agent kit 1.3.1 evaluation run, 168 of 168 quotes were found at the cited paragraph.',
        ],
      },
      {
        heading: 'One click to the page',
        paragraphs: ['A verified chip opens the document at the page, with the quoted words marked. The lawyer reads the source, not a summary of it.'],
      },
    ],
  },
  {
    slug: 'lumen-1-3',
    title: 'Lumen 1.3: new firms onboard in seconds',
    date: 'Oct 21, 2026',
    tag: 'Product',
    lead: 'A new firm is ready to work in seconds, and each firm stays behind its own walls: its own documents, its own agent, its own credentials.',
    sections: [
      {
        heading: 'What changed',
        paragraphs: [
          'Setting up a firm used to take minutes, because Lumen built a whole new environment for it. Now a firm gets its own walled document store, its own agent and its own server-held credentials the moment it signs up, and the legal agent kit is installed once and read-only for everyone.',
          'A restricted matter goes one step further: it gets its own store and its own agent, so not even the rest of the firm’s conversations can open it.',
          'In our tests a second firm could not mount, list or read the first firm’s documents or conversations.',
        ],
      },
    ],
  },
  {
    slug: 'typed-columns',
    title: 'Tabular review gets typed columns and Excel export',
    date: 'Oct 2, 2026',
    tag: 'Product',
    lead: 'A review column now has an answer type, and the grid leaves Lumen as a real spreadsheet.',
    sections: [
      {
        heading: 'Nine answer types',
        paragraphs: [
          'Text, yes or no, date, money, number, percentage, list, tag and verbatim quote. A percentage stays a number, so a rent increase of 8% sorts and sums in Excel; a list of termination events stays a list.',
          'Pick a column from the clause library of 24, or name your own and let Lumen write the question from the label and the type.',
        ],
      },
      {
        heading: 'Edit a column without losing work',
        paragraphs: ['A new label changes nothing else. A new question re-runs only that column, and every cell a lawyer verified or edited keeps its value.'],
      },
      {
        heading: 'Out to Excel',
        paragraphs: ['Export writes typed cells, the review state of each cell, and a second sheet with every citation: the document, the page, the status and the quoted words.'],
      },
    ],
  },
  {
    slug: 'playbooks',
    title: 'Playbooks: one source of truth for the firm’s positions',
    date: 'Sep 18, 2026',
    tag: 'Product',
    lead: 'A playbook is a document the firm owns. Contract review applies whichever version is current when the run starts.',
    sections: [
      {
        heading: 'Rules, positions, fallbacks',
        paragraphs: ['Each rule states the firm’s position, a fallback and the severity of a miss. Lumen checks every rule, quotes the clause it relied on and proposes the smallest redline.'],
      },
      {
        heading: 'Edits take effect on the next run',
        paragraphs: ['A run copies the playbook at its start, so a change never alters a review that already ran. The audit log records who changed what.'],
      },
    ],
  },
  {
    slug: 'isolated-workspaces',
    title: 'Why every Lumen task runs in its own workspace',
    date: 'Sep 4, 2026',
    tag: 'Security',
    lead: 'Each conversation and each run gets an isolated environment with the firm’s documents and Lumen’s tools mounted, and nothing else.',
    sections: [
      {
        heading: 'Walls that hold',
        paragraphs: ['A firm’s workspace mounts its own folder and a read-only copy of Lumen’s agent kit. In our tests a session of one firm could not mount, list or read another firm’s documents.'],
      },
      {
        heading: 'Real tools, safely',
        paragraphs: ['Because the environment is isolated, the agent can run real tools: read a scan, compare two versions, compute a notice period. When the task ends, the environment closes.'],
      },
    ],
  },
  {
    slug: 'designing-for-the-source',
    title: 'Designing for a lawyer who checks the source',
    date: 'Aug 21, 2026',
    tag: 'Design',
    lead: 'The most important control in Lumen is the small numbered chip after a sentence.',
    sections: [
      {
        heading: 'One click to the page',
        paragraphs: ['A chip opens the document at the page, with the quoted words marked in the lamp colour. A struck-through chip means Lumen could not find the quote.'],
      },
      {
        heading: 'Quiet by default',
        paragraphs: ['Serif titles, grey body text, one accent. Nothing on the screen competes with the clause.'],
      },
    ],
  },
];

export const postBySlug = (slug: string) => POSTS.find((p) => p.slug === slug);

export const ROLES = [
  { team: 'Engineering', title: 'Product engineer, review grid', place: 'London or remote' },
  { team: 'Engineering', title: 'Applied AI engineer, evaluation', place: 'London or remote' },
  { team: 'Legal', title: 'Legal engineer, transactional', place: 'London' },
  { team: 'Legal', title: 'Knowledge lawyer, playbooks', place: 'New York' },
  { team: 'Design', title: 'Product designer', place: 'Remote' },
  { team: 'Go to market', title: 'Customer success, law firms', place: 'London' },
];

export const NAV = {
  platform: [{ href: '/platform', label: 'Overview' }, ...PRODUCTS.map((p) => ({ href: `/platform/${p.slug}`, label: p.name }))],
  solutions: SOLUTIONS.map((s) => ({ href: `/solutions/${s.slug}`, label: s.name })),
  resources: [
    { href: '/blog', label: 'Blog' },
    { href: '/newsroom', label: 'Newsroom' },
    { href: '/press', label: 'Brand' },
    { href: '/company', label: 'Company' },
    { href: '/careers', label: 'Careers' },
  ],
};

export const FOOTER = [
  { label: 'Platform', links: NAV.platform },
  {
    label: 'Company',
    links: [
      { href: '/customers', label: 'Customers' },
      { href: '/security', label: 'Security' },
      { href: '/company', label: 'About' },
      { href: '/careers', label: 'Careers' },
      { href: '/newsroom', label: 'Newsroom' },
    ],
  },
  {
    label: 'Resources',
    links: [
      { href: '/blog', label: 'Blog' },
      { href: '/press', label: 'Brand' },
      { href: '/pricing', label: 'Pricing' },
      { href: '/legal', label: 'Legal' },
      { href: '/legal/privacy', label: 'Privacy' },
      { href: '/legal/terms', label: 'Terms' },
    ],
  },
  { label: 'Solutions', links: NAV.solutions },
  {
    label: 'Get started',
    links: [
      { href: '/demo', label: 'Request demo' },
      { href: '/sign-up', label: 'Start free trial' },
      { href: '/sign-in', label: 'Log in' },
    ],
  },
];
