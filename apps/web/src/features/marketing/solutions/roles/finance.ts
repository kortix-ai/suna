import type { RoleContent } from '../types';

/** Accuracy gate: `../types.ts`. Read it before editing. */
export const finance: RoleContent = {
  slug: 'finance',
  name: 'Finance',
  navDescription: 'The close, the reconciliation and the variance note',
  seoTitle: 'Kortix for finance teams',
  seoDescription:
    'Reconciliation, variance analysis and the schedules behind the close, run on a machine that shows its working. Every figure traces to a source, and nothing posts to a system of record without approval.',

  hero: {
    title: 'The close, with the working shown.',
    sub: 'Reconciliation, variance, the schedules that sit behind the number. An agent does the assembly on its own machine, writes down where every figure came from, and hands you a workbook you can check — not a number you have to believe.',
    microline: 'Every figure traces to a source · nothing posts without approval',
    specs: [
      { k: 'Runs on', v: 'A real machine with a shell' },
      { k: 'Produces', v: 'A workbook, a note, and the trace' },
      { k: 'Posting', v: 'Set it to Ask, or to Block' },
      { k: 'Recurs', v: 'On a cron, at period end' },
    ],
  },

  handoff: {
    title: 'The assembly, not the judgement.',
    sub: 'The month-end problem has never been the accounting. It is the four days of pulling, matching, chasing and formatting before anyone qualified gets to look at anything. That is exactly the shape of work a session is good at, and exactly the shape a spreadsheet macro never quite fit.',
    jobs: [
      {
        id: 'recon',
        title: 'Reconciliation, line by line',
        body: 'It matches the ledger against the statement, groups what did not match by likely cause, and leaves the genuinely ambiguous ones flagged rather than force-matched. The unmatched list is the deliverable; a clean run that hid three problems is not.',
      },
      {
        id: 'variance',
        title: 'Variance, with the reason attached',
        body: 'Plan against actual per cost centre, then the part people actually want: which transactions drove the variance, and a written explanation of each one that a non-finance reader can follow.',
      },
      {
        id: 'schedules',
        title: 'The supporting schedules',
        body: 'Accruals, prepayments, deferred revenue, fixed asset roll-forwards. Mechanical, rule-driven, and re-derived from source every period instead of a workbook that has been copied forward since 2023.',
      },
      {
        id: 'ap',
        title: 'Invoice intake and coding',
        body: 'It reads the invoice, extracts the fields, proposes the cost-centre and account coding against your own chart, and puts anything it is unsure about in a queue for a person rather than posting a plausible guess.',
      },
      {
        id: 'chase',
        title: 'The receivables chase',
        body: 'Who is late, by how long, and what was said last time. It drafts the next message per account in the right register — a first nudge and a fourth are not the same email — and leaves them for you to send.',
      },
      {
        id: 'board',
        title: 'The reporting pack',
        body: 'The same figures, assembled into the format the board reads, with the commentary drafted from the variance work rather than written from scratch at midnight.',
      },
    ],
  },

  output: {
    title: 'A workbook, and a note explaining every line in it.',
    sub: 'Finance is the one function where "the AI said so" is not an answer. So the output is built to be checked: every figure carries the source it was derived from, and the arithmetic is in a file you can open rather than inside a model.',
    artifact: {
      kind: 'table',
      file: 'close/2026-07/variance-by-cost-centre.xlsx',
      columns: ['Cost centre', 'Plan', 'Actual', 'Variance', 'Driver'],
      widths: ['26%', '16%', '16%', '16%', '26%'],
      rows: [
        {
          cells: [
            'R&D — platform',
            '1,225,000',
            '1,182,400',
            '−42,600',
            'Two hires started in month 3',
          ],
        },
        {
          cells: [
            'Cloud infrastructure',
            '410,000',
            '463,900',
            '+53,900',
            'Sandbox growth, 4 of 4 weeks',
          ],
        },
        {
          cells: [
            'Marketing — events',
            '180,000',
            '96,200',
            '−83,800',
            'Q3 conference moved to Q4',
          ],
        },
        { cells: ['Support', '312,000', '318,700', '+6,700', 'Contractor cover, weeks 2–3'] },
      ],
    },
    caption: 'Illustration. Figures are fictional and internally consistent, not a real ledger.',
    notes: [
      {
        id: 'trace',
        title: 'Every figure has a source',
        body: 'The workbook is derived, not typed. Each line carries the query or the document it came from, so the review question is "is this the right source" rather than "where did this number come from".',
      },
      {
        id: 'unsure',
        title: 'It is allowed to say it is not sure',
        body: 'Unmatched lines and uncertain codings arrive as a queue, not as a decision. An agent that resolves ambiguity quietly is worse than no agent at all in this function.',
      },
      {
        id: 'repo',
        title: 'The method lives in the repo',
        body: 'How your close works — the matching rules, the coding conventions, the commentary style — is a skill file in the workspace. It is versioned, it is diffable, and improving it is a change someone reviews.',
      },
    ],
  },

  reach: {
    title: 'The ledger, the bank feed, the spreadsheet everyone actually uses.',
    sub: 'Finance systems are the ones where read and write are genuinely different risks. Connect each once for the workspace; every credential is decrypted on our side and attached to the outbound call, never placed in the machine.',
    rows: [
      {
        k: 'Stripe',
        v: 'Connected directly from its API description rather than through a middleman: Kortix reads the specification, works out the authentication, and turns every operation into a tool with its own answer.',
      },
      {
        k: 'Google Sheets and Drive',
        v: 'Where the working actually lives in most finance teams. It reads the plan, writes the workbook, and leaves the file where the team already opens it.',
      },
      {
        k: 'Your accounting and banking systems',
        v: 'If your ledger is in the Easy connect catalogue it is a click and an OAuth screen. If it is not — and plenty of accounting systems are not — it is reachable through OpenAPI, a Postman collection, GraphQL, raw HTTP or a remote MCP server.',
      },
      {
        k: 'Gmail and Outlook',
        v: 'For the intake half: invoices arrive as attachments, and chasers go out as drafts. Reading a mailbox and sending from it are separate actions with separate answers.',
      },
      {
        k: 'Slack',
        v: 'The one live channel. Ask a question about the close in a thread and the thread is the session; the workbook comes back into it as a file.',
      },
    ],
    footnote:
      'Easy connect covers 3,000+ apps through their own OAuth screens, but we will not pretend every finance system is in it. Where the catalogue does not reach, the direct connector types do — and if your ledger has no API at all, the honest answer is that this stays a workbook-and-approval workflow.',
  },

  cadence: {
    title: 'Ask on the fifteenth. Run it on the first.',
    sub: 'Finance work is the most naturally scheduled work in the company, which makes it the most natural fit for a trigger — and the most important place to be exact about what a trigger is allowed to do.',
    modes: [
      {
        id: 'on-demand',
        label: 'On demand',
        title: '"Why is cloud infrastructure over?"',
        body: 'Ask mid-month and a session pulls the transactions behind the line and comes back with the ones that moved it. No waiting for a report cycle to answer a question about a number.',
      },
      {
        id: 'human-assisted',
        label: 'Human-assisted',
        title: 'It stops before it posts',
        body: 'Reading the ledger and writing to it are different actions. Set the write to Ask and the run pauses at the call with the exact entry in front of you; approve and the same call completes.',
      },
      {
        id: 'automated',
        label: 'Automated',
        title: 'The close, started before you are in',
        body: 'A cron trigger opens the period-end session on the first working day, does the assembly overnight and leaves the workbook and the unmatched queue waiting. The judgement is still yours; the four days of assembly are not.',
      },
    ],
  },

  control: {
    title: 'What it may read, what it may post, what it may never do.',
    sub: 'The controls that matter in finance are not about the model. They are about which outbound calls are allowed, who approved them, and whether you can prove it afterwards.',
    rows: [
      {
        id: 'gates',
        k: 'Approval gates are off until you set them',
        v: 'The shipped default is permissive — an action runs unless you have said otherwise. In a finance workspace, setting Ask on every write to a system of record and Block on every delete is the first configuration change to make, not something already done for you.',
      },
      {
        id: 'block',
        k: 'Block is not an approval you can grant in the moment',
        v: 'An action set to Block is unavailable, and no approval prompt can lift it while a session is running. Voiding a payment stays off the table by configuration rather than by good judgement under time pressure.',
      },
      {
        id: 'merge',
        k: 'Merge is default-deny',
        v: 'Work the agent means to keep is committed on the session branch and reaches main through a change request. An agent cannot merge unless an admin has granted project.cr.merge in kortix.yaml — and widening that grant is itself a reviewed change.',
      },
      {
        id: 'creds',
        k: 'Connector credentials never enter the machine',
        v: 'The sandbox carries one workspace-scoped Kortix token and no third-party keys. The banking or ledger credential is decrypted server-side and attached to the outbound request, then thrown away.',
      },
      {
        id: 'audit',
        k: 'A record per call, with the approver on it',
        v: 'The connector and exact action, the agent, the person or trigger behind the session, the outcome, a hash of the inputs, and who released a held call. The gateway that resolves the credential is the same thing that writes the row.',
      },
    ],
  },

  closing: {
    title: 'Hand over the assembly. Keep the judgement.',
    sub: 'Open source and self-hostable. Any model, your keys. Kortix Cloud, your own VPC, or your own on-prem network.',
  },
};
