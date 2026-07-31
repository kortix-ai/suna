import type { RoleContent } from '../types';

/** Accuracy gate: `../types.ts`. Read it before editing. */
export const product: RoleContent = {
  slug: 'product',
  name: 'Product',
  navDescription: 'Feedback synthesised into specs, with the evidence attached',
  seoTitle: 'Kortix for product teams',
  seoDescription:
    'Turn scattered feedback into a spec with the evidence attached, keep the tracker honest, and write the release notes from the actual diff. Everything lands as a document a person reviews.',

  hero: {
    title: 'The evidence, gathered — so the decision is yours to make.',
    sub: 'Feedback arrives in six places and gets read in none of them. An agent reads all six, groups what is actually the same request, writes the spec against the real quotes, and cites every one of them. You decide what to build. It does the reading.',
    microline: 'Every claim cites the ticket it came from · drafts, never decisions',
    specs: [
      { k: 'Reads', v: 'Tickets, threads, the tracker, the repo' },
      { k: 'Writes', v: 'Specs, notes, summaries — as files' },
      { k: 'Cites', v: 'The source behind every claim' },
      { k: 'Decides', v: 'Nothing. That part is still yours' },
    ],
  },

  handoff: {
    title: 'Reading everything, so you can think about something.',
    sub: 'The product job degrades into an inbox. Four hundred tickets, three channels, a tracker somebody stopped grooming in April, and a nagging sense that the thing you are about to prioritise was already asked for in a thread you never saw.',
    jobs: [
      {
        id: 'synthesis',
        title: 'Feedback synthesis that survives a challenge',
        body: 'It clusters requests by what people actually want rather than by the words they used, counts how many distinct accounts raised each one, and attaches the quotes. When someone asks "who asked for this", the answer is in the document.',
      },
      {
        id: 'spec',
        title: 'The first draft of the spec',
        body: 'Written from the evidence and from the code that already exists — it reads the repo, so the draft knows which of the three proposals is nearly built already. It is a draft to argue with, not a plan to accept.',
      },
      {
        id: 'grooming',
        title: 'The tracker, kept honest',
        body: 'Duplicates merged, stale items surfaced, issues whose linked change request shipped three weeks ago closed. A backlog that is 40% archaeology is not a backlog.',
      },
      {
        id: 'notes',
        title: 'Release notes from the actual diff',
        body: 'It reads what merged since the last release, not what the tickets promised, and writes the note in your register. The two lists differ more often than anyone admits.',
      },
      {
        id: 'competitive',
        title: 'The competitive watch',
        body: 'A scheduled session reads what has publicly changed, says what is genuinely new, and says plainly when nothing is. A weekly digest that manufactures a finding every week is a weekly digest nobody reads by month three.',
      },
      {
        id: 'brief',
        title: 'The pre-read for the review',
        body: 'Before the roadmap meeting: what moved, what slipped and why, which assumptions in the last spec turned out wrong. Assembled from the tracker and the repo rather than from memory.',
      },
    ],
  },

  output: {
    title: 'A document with its sources in it.',
    sub: 'A synthesis you cannot check is a synthesis you should not trust. So every grouping carries the tickets underneath it and every claim about what people want carries the thing a person actually said.',
    artifact: {
      kind: 'doc',
      file: 'specs/2026-07-bulk-export.md',
      title: 'Bulk export — draft spec',
      meta: [
        { k: 'Sources', v: '31 tickets · 9 threads' },
        { k: 'Accounts', v: '14 distinct' },
        { k: 'Status', v: 'Draft · for review' },
        { k: 'Prior art', v: 'packages/export/' },
      ],
      lines: [
        'Fourteen accounts asked for the same thing in three different vocabularies: "bulk export", "give me a CSV", and "the API is too slow for a backfill". They are one request.',
        'Two of the fourteen do not want an export at all. They want a scheduled delivery, and an export button would not close their ticket. Those two are separated out below rather than counted toward the total.',
        'Prior art: packages/export/ already streams a single record set. The gap is pagination across the account, not serialisation — which changes the size of this from a quarter to a fortnight.',
      ],
    },
    caption: 'Illustration. The tickets, accounts and paths are fictional.',
    notes: [
      {
        id: 'cited',
        title: 'Every grouping opens up',
        body: 'A cluster is not a claim, it is a list. The document carries the tickets behind each group, so a disagreement about the synthesis is a disagreement you can settle by reading rather than by re-doing the work.',
      },
      {
        id: 'code',
        title: 'It has read the codebase too',
        body: 'The session clones the repo, so the spec can say what already exists. A draft that knows the serialisation is done and the pagination is not is worth an order of magnitude more than one written from tickets alone.',
      },
      {
        id: 'draft',
        title: 'It is a draft, and it says so',
        body: 'The document lands as a change request against main, marked as a draft. Product decisions do not get made by an agent here — the point is that the reading is done before you make one.',
      },
    ],
  },

  reach: {
    title: 'The places feedback actually lands.',
    sub: 'Product feedback does not live in one system, which is the entire problem. Connect each source once for the project; the credential is resolved on our side of the wall and never enters the machine.',
    rows: [
      {
        k: 'Linear',
        v: 'Read the tracker as it really is — issues, states, links, comments — and write back the groomed result where you allow it to. The tracker stays the system of record; the agent is not a second one.',
      },
      {
        k: 'GitHub',
        v: 'Issues, discussions and what actually merged. This is where release notes come from, because the diff is the only honest record of what shipped.',
      },
      {
        k: 'Zendesk, Intercom and the rest of the support stack',
        v: 'In the Easy connect catalogue: click through the OAuth screen and the connection belongs to the project. Support tickets are where the highest-signal feedback is and the lowest-signal summaries get made.',
      },
      {
        k: 'Notion and Google Drive',
        v: 'Where specs, research and the last six months of decisions live. It reads them as prior art so a new draft does not re-litigate something settled in March.',
      },
      {
        k: 'Slack',
        v: 'The one live channel. The thread where a customer complaint got pasted is often the only place that complaint exists — and a mention in that thread starts a session on it.',
      },
    ],
    footnote:
      'Easy connect covers 3,000+ apps through their own OAuth screens. If your feedback lives somewhere that is not in the catalogue — a community forum, an in-house portal — it is reachable through OpenAPI, GraphQL, raw HTTP or a remote MCP server instead.',
  },

  cadence: {
    title: 'Ask before the meeting. Run it every Monday.',
    sub: 'The same session machinery started three ways. Product work is mostly reading, which makes the scheduled mode unusually valuable here.',
    modes: [
      {
        id: 'on-demand',
        label: 'On demand',
        title: '"What has anyone said about export?"',
        body: 'Ask in a Slack thread. The session reads across the tracker, the tickets and the threads, and answers in the same thread with the document attached.',
      },
      {
        id: 'human-assisted',
        label: 'Human-assisted',
        title: 'It stops before it touches the tracker',
        body: 'Reading a tracker and rewriting it are different actions. Set the write to Ask and the run holds at the call, showing you exactly which issues it wants to merge or close, and resumes from there when you approve.',
      },
      {
        id: 'automated',
        label: 'Automated',
        title: 'The Monday digest and the release note',
        body: 'One cron trigger writes the weekly synthesis. A signed webhook off your release process starts a session that drafts the notes from the diff. Both land as documents someone reviews.',
      },
    ],
  },

  control: {
    title: 'It gathers. You decide.',
    sub: 'The failure mode for a product agent is not a bad merge. It is a confident summary of something nobody said. So the controls here are about traceability as much as about permissions.',
    rows: [
      {
        id: 'evidence',
        k: 'A claim without a source is a bug',
        v: 'The synthesis format carries the tickets behind every group and the quote behind every assertion. That is a convention you enforce in a skill file in your repo — versioned, diffable, and improved through a change someone reviews.',
      },
      {
        id: 'gates',
        k: 'Approval gates are off until you set them',
        v: 'The shipped default is permissive: an action runs unless you have said otherwise. Set Ask on anything that writes to the tracker and Block on anything that deletes from it. We are stating the real default rather than the comfortable one.',
      },
      {
        id: 'merge',
        k: 'Merge is default-deny',
        v: 'Specs, notes and research land on the session branch and reach main through a change request. An agent cannot merge unless an admin has granted project.cr.merge in kortix.yaml, and widening the grant is itself a reviewed change.',
      },
      {
        id: 'creds',
        k: 'Connector credentials never enter the machine',
        v: 'The sandbox carries one project-scoped Kortix token and no third-party keys. Your tracker and helpdesk credentials are decrypted server-side and attached to the outbound call.',
      },
      {
        id: 'memory',
        k: 'What it learns is a file, not a black box',
        v: 'The conventions, the taxonomy, the way your team words a release note — all of it lives in the repo as markdown. You can read it, edit it, and diff what changed the day the output changed.',
      },
    ],
  },

  closing: {
    title: 'Do the reading. Keep the deciding.',
    sub: 'Open source and self-hostable. Any model, your keys. Kortix Cloud, your own VPC, or your own on-prem network.',
  },
};
