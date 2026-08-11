import type { RoleContent } from '../types';

/** Accuracy gate: `../types.ts`. Read it before editing. */
export const it: RoleContent = {
  slug: 'it',
  name: 'IT',
  navDescription: 'Runbooks that execute, and a platform that survives your review',
  seoTitle: 'dosco for IT teams',
  seoDescription:
    'Access reviews, joiner-mover-leaver runs and service-desk triage, run as sessions on isolated machines. Plus the honest answers IT needs before approving an agent platform at all.',

  hero: {
    title: 'You have to run it, and you have to approve it. Both, honestly.',
    sub: 'Access reviews, joiner-mover-leaver, the service desk queue, the runbook that only one person can execute. IT gets more out of an agent platform than most teams — and is the team that has to say yes to it first. This page does both halves.',
    microline: 'Runbooks that execute · deny-by-default reach · SAML 2.0 single sign-on',
    specs: [
      { k: 'Runbooks', v: 'Markdown in your repo, not in a head' },
      { k: 'Reach', v: 'Granted per agent, never inherited' },
      { k: 'Every action', v: 'Allowed, gated, or blocked' },
      { k: 'Deployment', v: 'Cloud, your VPC, or on-prem' },
    ],
  },

  handoff: {
    title: 'The queue, and the runbook only one person can execute.',
    sub: 'IT work is unusually well suited to this: it is procedural, it is written down somewhere already, and the cost of it not happening is invisible right up until an audit or an incident.',
    jobs: [
      {
        id: 'jml',
        title: 'Joiner, mover, leaver',
        body: 'The mover case is where it earns its keep. A joiner gets a checklist and a leaver gets urgency; someone changing team quietly keeps both sets of access forever. A scheduled session finds those and drafts the revocations.',
      },
      {
        id: 'access',
        title: 'The access review that actually gets done',
        body: 'Who has what, how long they have had it, and when they last used it. It produces the review with a proposed action per row rather than a spreadsheet that gets forwarded twice and approved unread.',
      },
      {
        id: 'triage',
        title: 'Service desk triage and first draft',
        body: 'It reads the ticket, classifies it, finds whether your own documentation already answers it, and drafts the reply with the article linked. The ones it cannot answer get routed with the diagnosis already attached.',
      },
      {
        id: 'runbook',
        title: 'The runbook that lives in one person’s head',
        body: 'Write it down as a skill file and a session can execute it. That is the durable version of "ask Marta" — it survives Marta being on holiday, and improving it is a change request rather than a corrected memory.',
      },
      {
        id: 'licences',
        title: 'Licence and seat reconciliation',
        body: 'What you pay for against what is assigned against what was opened this quarter. It writes the reclaim list per tool with the last-used date on every row.',
      },
      {
        id: 'drift',
        title: 'Configuration drift, reported not fixed',
        body: 'It compares what your documentation says is configured against what is actually configured, and reports the difference. Reporting drift is safe and useful. Silently correcting it is neither, and it will not.',
      },
    ],
  },

  output: {
    title: 'A review with a recommendation on every row.',
    sub: 'The artifact IT actually needs is not a dashboard. It is a list, with a defensible reason attached to each line, in a state where approving it does something.',
    artifact: {
      kind: 'table',
      file: 'access/2026-q3-review-production.md',
      columns: ['Principal', 'Grant', 'Granted', 'Last used', 'Recommendation'],
      widths: ['22%', '20%', '14%', '14%', '30%'],
      rows: [
        {
          cells: [
            'j.okafor',
            'db · read-write',
            '14 mo',
            '9 mo',
            'Revoke — moved to Support in Q1',
          ],
        },
        { cells: ['deploy-bot', 'registry · push', '8 mo', '2 h', 'Keep — in the release path'] },
        {
          cells: [
            'a.lindqvist',
            'admin console',
            '22 mo',
            'never',
            'Revoke — granted for a migration',
          ],
        },
        { cells: ['support-agent', 'helpdesk · read', '3 mo', '11 m', 'Keep — scoped, read only'] },
      ],
    },
    caption:
      'Illustration. The principals are fictional. Note that one of them is an agent — both kinds of principal appear in the same review.',
    notes: [
      {
        id: 'principals',
        title: 'Agents are principals too',
        body: 'dosco has a real account, member, group and role model with per-resource permissions for people and for agents. An access review that covers your humans and not your automation is half a review.',
      },
      {
        id: 'reason',
        title: 'A recommendation, with the reason on the row',
        body: 'Revoke because they moved team. Keep because it is in the release path. A review you can approve in ten minutes is one where the reasoning is on the line, not in a separate document.',
      },
      {
        id: 'reports',
        title: 'It reports; it does not silently remediate',
        body: 'Revocation is a write, and writes are where you set a gate. The default configuration for a review session should be read-everything, change-nothing, and propose.',
      },
    ],
  },

  reach: {
    title: 'Your estate, reached the way it is actually reachable.',
    sub: 'IT tooling is the least uniform stack in the company. Connect what is in the catalogue; define the rest yourself. Either way the credential is decrypted on our side and never enters the machine.',
    rows: [
      {
        k: 'Google Workspace and Microsoft 365',
        v: 'Accounts, groups, mailboxes and calendars — the substrate most joiner-mover-leaver work runs against. Read and write are separate actions with separate answers.',
      },
      {
        k: 'GitHub',
        v: 'Repository and organisation membership is access too, and it is the access that most often outlives the reason for it. It reads the org state and reports what does not match your documented roles.',
      },
      {
        k: 'Your service desk',
        v: 'The mainstream helpdesk products are in the Easy connect catalogue behind their own OAuth screens. Read the queue, draft the reply, and update the ticket where you have allowed it to.',
      },
      {
        k: 'Everything with an API and no catalogue entry',
        v: 'This is most of an IT estate. Point dosco at an OpenAPI or Postman description, a GraphQL endpoint, a bare HTTP base URL, or a remote MCP server. It reads the source, works out the authentication, and turns each operation into a tool with its own Allow, Ask or Block.',
      },
      {
        k: 'A machine you already run',
        v: 'A computer connector opens a tunnel to a host you control, so a session can reach something that was never going to be exposed to the internet — without that host being on the public network.',
      },
    ],
    footnote:
      'Easy connect covers 3,000+ apps through their own OAuth screens. We are not going to claim your identity provider, your MDM and your network vendor are all in it — for an IT estate the direct connector types are usually the real path, and they take about the same three minutes.',
  },

  cadence: {
    title: 'Answer the ticket now. Run the review every quarter.',
    sub: 'The same session machinery started three ways. IT is the function where the scheduled mode does the most good, because the work that gets skipped is the work with no deadline attached.',
    modes: [
      {
        id: 'on-demand',
        label: 'On demand',
        title: 'The question in the help channel',
        body: 'Someone mentions the bot in the IT channel. The thread becomes a session, the session reads your documentation, and the answer lands back in the same thread with the source quoted.',
      },
      {
        id: 'human-assisted',
        label: 'Human-assisted',
        title: 'It stops before it changes access',
        body: 'Set every write against an identity or an entitlement to Ask. The run holds at the call with the exact change in front of you, and resumes from that point when you approve. Set the irreversible ones to Block instead.',
      },
      {
        id: 'automated',
        label: 'Automated',
        title: 'The review nobody schedules, scheduled',
        body: 'A cron trigger opens the quarterly access review and the monthly licence reconciliation. Triggers name the agent they run as, so the unattended session has exactly the reach the attended one has — no more.',
      },
    ],
  },

  control: {
    title: 'The part where you review us.',
    sub: 'You are also the team that has to approve this. Here are the answers, including the ones that are less flattering than the version you usually get on a page like this.',
    rows: [
      {
        id: 'isolation',
        k: 'One isolated machine per session',
        v: 'Every session runs on its own disposable Linux machine on its own branch. Sessions do not share a filesystem or a working tree, and the machine is thrown away. What we will not tell you is that egress is controlled at the network — nothing implements that, and you should assume outbound access from a sandbox.',
      },
      {
        id: 'gates',
        k: 'Approval gates are off by default',
        v: 'The shipped default is permissive: an action runs unless you have said otherwise. This is the single most important sentence on this page for you. Set Ask and Block explicitly, per action or with a pattern rule, and note that a rule can match on the arguments and not just the tool name.',
      },
      {
        id: 'merge',
        k: 'Merge is default-deny',
        v: 'Work reaches main through a change request. An agent cannot merge unless an admin has granted project.cr.merge in kortix.yaml — a text grant in a versioned file, so widening it is itself a reviewed change rather than a setting that quietly moved.',
      },
      {
        id: 'secrets',
        k: 'Two kinds of credential, and they behave differently',
        v: 'A connector credential is brokered server-side and never enters the sandbox. A runtime secret you grant a session IS a real environment value inside it and is readable by any command the agent runs. Both are correct designs for their job; do not let anyone tell you the second one is invisible to the model.',
      },
      {
        id: 'deploy',
        k: 'Identity, audit and where it runs',
        v: 'Single sign-on is SAML 2.0. Every tool call is written to an audit record with the agent, the person or trigger, the outcome and the approver. Deployment is dosco Cloud, your own VPC, or your own on-prem network — it is open source, so you can read what you are running. It is not air-gapped: starting a self-hosted stack pulls images over the network. For an isolated topology, talk to us.',
      },
    ],
  },

  closing: {
    title: 'Read the security page before the pitch.',
    sub: 'Open source and self-hostable. Any model, your keys. dosco Cloud, your own VPC, or your own on-prem network.',
  },
};
