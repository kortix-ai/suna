import type { RoleContent } from '../types';

/** Accuracy gate: `../types.ts`. Read it before editing. */
export const sales: RoleContent = {
  slug: 'sales',
  name: 'Sales',
  navDescription: 'Research, drafts and CRM hygiene, held for your approval',
  seoTitle: 'dosco for sales teams',
  seoDescription:
    'Hand a sales agent the research, the pre-call brief, the CRM write-back and the follow-up draft. Nothing sends until you approve it, and every action it took is written down.',

  hero: {
    title: 'Everything around the conversation, so you can have the conversation.',
    sub: 'The research, the pre-call brief, the notes typed back into the CRM, the follow-up drafted from what was actually said. An agent picks up the work that sits either side of a call — and nothing leaves the building without your approval.',
    microline: 'Drafts, not sends · every action logged · your CRM, your rules',
    specs: [
      { k: 'Reaches', v: 'Your CRM, your inbox, your sheets' },
      { k: 'Credentials', v: 'Brokered server-side, never in the machine' },
      { k: 'Sending', v: 'Set it to Ask and the run pauses' },
      { k: 'Every call', v: 'Written to an audit record' },
    ],
  },

  handoff: {
    title: 'The half of the job that is not selling.',
    sub: 'Nobody joined a sales team to update a CRM. But the pipeline is only as good as the data in it, and the data is only as good as the last hour someone was willing to spend on admin. That hour is the handoff.',
    jobs: [
      {
        id: 'brief',
        title: 'The pre-call brief',
        body: 'Before a meeting it assembles what you would have skimmed anyway: the account history in the CRM, the open threads in the inbox, what the company has said publicly since you last spoke, and the two things that changed. One page, in your inbox, before the call.',
      },
      {
        id: 'notes',
        title: 'Call notes into the CRM, in your fields',
        body: 'You paste the notes or drop the transcript in a thread; it writes them back into the right record, updates the stage, sets the next step, and flags what it could not confidently place rather than guessing at a picklist value.',
      },
      {
        id: 'hygiene',
        title: 'The hygiene pass nobody runs',
        body: 'Duplicate accounts, opportunities with a close date in the past, contacts with no owner, deals that have not moved in six weeks. It produces the list with a proposed action per row — not a dashboard telling you the list exists.',
      },
      {
        id: 'research',
        title: 'Account research that is actually current',
        body: 'It reads what the company has published, matches it against your own qualifying criteria, and says whether the account fits and why. When it does not fit, it says that too, which is the more useful half.',
      },
      {
        id: 'followup',
        title: 'The follow-up, drafted from what was said',
        body: 'Written against the notes and the account record rather than a template with a merge field. It lands in the CRM or your inbox as a draft. Sending is an action you can require approval on.',
      },
      {
        id: 'renewal',
        title: 'Renewal and expansion watch',
        body: 'A scheduled session reads which contracts come up, which accounts have gone quiet, and which have grown — and opens a thread with the shortlist and a first draft per account.',
      },
    ],
  },

  output: {
    title: 'A worklist with a proposed action on every row.',
    sub: 'A report tells you what is wrong. A sales session hands you the rows and the specific thing it wants to do to each one, already drafted, waiting for a yes. The difference between those two is the whole product.',
    artifact: {
      kind: 'table',
      file: 'pipeline/2026-07-31-gone-quiet.md',
      columns: ['Account', 'Stage', 'Last touch', 'Drafted action'],
      widths: ['26%', '20%', '18%', '36%'],
      rows: [
        {
          cells: [
            'Northwind Logistics',
            'Proposal',
            '31 days',
            'Follow-up on the pricing question',
          ],
        },
        { cells: ['Acme Robotics', 'Discovery', '19 days', 'Re-book — champion changed role'] },
        { cells: ['Globex Health', 'Negotiation', '12 days', 'Send the security review pack'] },
        {
          cells: ['Initech Retail', 'Proposal', '44 days', 'Close-lost: no reply to three touches'],
        },
      ],
    },
    caption:
      'Illustration. Northwind, Acme, Globex and Initech are placeholders — dosco never names a customer.',
    notes: [
      {
        id: 'draft',
        title: 'Drafted is not sent',
        body: 'Every message it writes lands as a draft in the CRM or the inbox. If you want a hard stop before anything goes out, set the send action to Ask and the run pauses at the call and waits for you.',
      },
      {
        id: 'evidence',
        title: 'It shows what it read',
        body: 'Each row carries the record and the thread it drew from. A claim about an account that you cannot trace back to a source is a claim you should not act on, so it does not make one.',
      },
      {
        id: 'thread',
        title: 'It arrives where you already are',
        body: 'Connect Slack and the shortlist lands in a thread you can argue with. Reply in the same thread and you are talking to the same session, not starting a new one.',
      },
    ],
  },

  reach: {
    title: 'Your CRM and your inbox — without handing over the keys.',
    sub: 'A sales agent is only useful if it can reach the systems the pipeline actually lives in. Connect each one once for the whole project. The raw credential is decrypted on our side and attached to the outbound call; it never lands in the machine the model is driving.',
    rows: [
      {
        k: 'Salesforce, HubSpot',
        v: 'In the Easy connect catalogue: click through the OAuth screen and the connection belongs to the project. Read accounts, opportunities and activity; write back the fields you allow it to write.',
      },
      {
        k: 'Gmail and Outlook',
        v: 'Read the threads on an account and draft the reply. Reading and sending are separate actions with separate answers, so "may read the thread" never silently means "may send as me".',
      },
      {
        k: 'Google Sheets and Drive',
        v: 'The forecast that lives in a spreadsheet, the pricing sheet, the account plan. It reads them as source and writes the worklist back where the team already looks.',
      },
      {
        k: 'Slack',
        v: 'The one live channel. A mention in a thread starts a session and the answer comes back into the same thread. Microsoft Teams is shipped but stays off until your deployment turns it on.',
      },
      {
        k: 'Whose account it acts as',
        v: 'Choose one project-managed connection the whole team shares, or a personal authorization where every member acts as themselves — and an automated principal cannot act at all.',
      },
    ],
    footnote:
      'Easy connect covers 3,000+ apps through their own OAuth screens. If your sales stack includes something that is not in that catalogue — an internal quoting service, a regional CRM — it is still reachable through OpenAPI, GraphQL, raw HTTP or a remote MCP server.',
  },

  cadence: {
    title: 'Before the call, during the week, and at 07:00 on a Monday.',
    sub: 'The same session machinery started three different ways. What changes is when it runs, not what it is allowed to do.',
    modes: [
      {
        id: 'on-demand',
        label: 'On demand',
        title: '"Brief me on Northwind before eleven"',
        body: 'Ask in a Slack thread or from the web app. The session starts, does the reading, and answers in the thread with the brief attached as a file.',
      },
      {
        id: 'human-assisted',
        label: 'Human-assisted',
        title: 'It stops at the send',
        body: 'Set the send action to Ask and the run holds at the call, showing you the message and who it is addressed to. Approve and the same call completes. Deny and the session carries on without it.',
      },
      {
        id: 'automated',
        label: 'Automated',
        title: 'The Monday list, written overnight',
        body: 'A cron trigger runs the hygiene pass and the gone-quiet sweep before anyone is at a desk, and posts the worklist into the channel. Triggers name the agent they run as, so the overnight session gets no more reach than the daytime one.',
      },
    ],
  },

  control: {
    title: 'Nothing goes to a customer without a yes.',
    sub: 'Sales is the function where an autonomous mistake is a customer-visible mistake. So be precise about the defaults rather than reassuring about them.',
    rows: [
      {
        id: 'gates',
        k: 'Approval gates are off until you set them',
        v: 'The shipped default is permissive — an action runs unless you have said otherwise. For a sales project the first thing to do is set the outbound actions to Ask and the destructive ones to Block. We are telling you this rather than letting you assume the safer default was chosen for you.',
      },
      {
        id: 'pause',
        k: 'An approval pauses the run, it does not fail it',
        v: 'A gate that errors out teaches an agent to route around it. A dosco gate holds the call open, so you answer while the session is still mid-task and it resumes from exactly where it stopped.',
      },
      {
        id: 'args',
        k: 'The rule can read the arguments',
        v: '"May the agent send email?" is rarely the question. Conditions match on the values in the call, so a rule can allow sending inside your own domain and stop at everything else. Anything the rule cannot decide resolves toward less access.',
      },
      {
        id: 'creds',
        k: 'Connector credentials never enter the machine',
        v: 'The sandbox carries one project-scoped dosco token and no third-party keys. Your CRM credential is decrypted server-side and attached to the outbound request. Turning a connector off takes effect on the next call — there is nothing in the sandbox to rotate.',
      },
      {
        id: 'audit',
        k: 'Every call it made, and who let it',
        v: 'The record carries the connector and exact action, the agent, the person or trigger behind the session, the outcome, and who released a held call. There is no path to a connected tool that skips the thing writing the record.',
      },
    ],
  },

  closing: {
    title: 'Give it the admin. Keep the conversations.',
    sub: 'Open source and self-hostable. Any model, your keys. dosco Cloud, your own VPC, or your own on-prem network.',
  },
};
