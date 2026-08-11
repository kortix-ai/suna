import type { RoleContent } from '../types';

/** Accuracy gate: `../types.ts`. Read it before editing. */
export const people: RoleContent = {
  slug: 'people',
  name: 'People',
  navDescription: 'Scheduling, kits and onboarding — never the hiring decision',
  seoTitle: 'Kortix for people and recruiting teams',
  seoDescription:
    'Interview kits, scheduling, onboarding runs and policy answers drawn from your own handbook. Kortix does the coordination; a person makes every decision about a person.',

  hero: {
    title: 'The coordination. Never the decision about a person.',
    sub: 'Scheduling across four calendars, the interview kit built from the actual scorecard, the onboarding checklist that runs itself, the policy question answered from your handbook rather than from the internet. An agent does the logistics. A human does the judgement — and we mean that as a boundary, not a slogan.',
    microline: 'Coordination and drafting · a person decides about a person',
    specs: [
      { k: 'Does', v: 'Scheduling, kits, onboarding, answers' },
      { k: 'Does not', v: 'Rank, score or reject a candidate' },
      { k: 'Answers from', v: 'Your handbook, in your repo' },
      { k: 'Personal data', v: 'Stays in the systems you connected' },
    ],
  },

  handoff: {
    title: 'The logistics that eat a hiring week.',
    sub: 'A People team is judgement plus an enormous amount of coordination, and the coordination is what stops the judgement happening. Every job below is the coordination half — deliberately.',
    jobs: [
      {
        id: 'scheduling',
        title: 'Scheduling across four calendars',
        body: 'Find the slot that works for the panel and the candidate, send the invitations with the right materials attached, and re-run the whole thing when one interviewer drops. The single most reliable source of hiring delay, and pure logistics.',
      },
      {
        id: 'kit',
        title: 'The interview kit, built from the scorecard',
        body: 'For each stage: what this interview is testing, questions that actually test it, and what a strong and a weak answer look like. Generated from your own scorecard in the repo, so a new interviewer runs the same loop as an experienced one.',
      },
      {
        id: 'debrief',
        title: 'The debrief pack',
        body: 'It assembles what every interviewer wrote, arranged against the scorecard rather than by who typed most, and highlights where two interviewers disagreed. Surfacing disagreement is the point. Resolving it is the panel’s job.',
      },
      {
        id: 'onboarding',
        title: 'Onboarding that runs itself',
        body: 'Accounts requested, the reading list assembled, the first-week plan drafted from the role, the buddy pinged. It is a checklist that executes instead of a checklist somebody has to remember to open.',
      },
      {
        id: 'policy',
        title: 'Policy questions, answered from your handbook',
        body: 'Asked in a Slack thread, answered from the document in your repo with the section quoted. If your handbook does not answer it, it says that and routes to a person rather than filling the gap with a plausible policy.',
      },
      {
        id: 'jd',
        title: 'The job description, drafted from the real team',
        body: 'It reads the roles you already have and the work that team actually does before writing the posting, so the description matches the job rather than the last posting for a similar title.',
      },
    ],
  },

  output: {
    title: 'A kit any interviewer can run.',
    sub: 'The output here is deliberately about the process, not about the person. It makes the loop consistent and the bar explicit — which is the part a tool can genuinely improve.',
    artifact: {
      kind: 'doc',
      file: 'hiring/platform-engineer/stage-2-systems.md',
      title: 'Stage 2 — systems design · interviewer kit',
      meta: [
        { k: 'Scorecard', v: 'hiring/scorecards/platform.md' },
        { k: 'Stage', v: '2 of 4 · 60 minutes' },
        { k: 'Tests', v: 'Failure reasoning' },
        { k: 'Status', v: 'Draft · for review' },
      ],
      lines: [
        'What this stage is for: whether the candidate reasons about failure before they reason about throughput. It is not a breadth check — stage 3 covers breadth, and asking here duplicates it.',
        'Open with a system they have actually operated, not a hypothetical. Follow the first failure mode they name all the way down. A strong answer gets more specific under pressure; a weak one gets more abstract.',
        'Not in scope for this stage, and flagged because interviewers keep straying into it: compensation, notice period, and anything that belongs to the recruiter conversation.',
      ],
    },
    caption: 'Illustration. The role, the scorecard and the paths are fictional.',
    notes: [
      {
        id: 'process',
        title: 'It works on the process, not on the person',
        body: 'The kit, the schedule, the debrief structure, the onboarding plan. Every one of those is about how you run hiring. None of them is a judgement about a candidate, and that boundary is a deliberate product position rather than a limitation.',
      },
      {
        id: 'handbook',
        title: 'Your handbook is the source',
        body: 'Policy answers come from the document in your repo with the section quoted. A question the handbook does not cover gets routed to a person — the gap is reported, not filled.',
      },
      {
        id: 'consistent',
        title: 'The same loop for every candidate',
        body: 'The value of generating the kit from the scorecard is not speed. It is that the fifteenth candidate gets the same interview as the first, which is a fairness property before it is an efficiency one.',
      },
    ],
  },

  reach: {
    title: 'The calendar, the inbox, the applicant system.',
    sub: 'People systems hold the most sensitive data in the company, so the mechanism matters more here than anywhere else on this site. Connect each once for the workspace; the credential is decrypted on our side and attached to the outbound call.',
    rows: [
      {
        k: 'Google Workspace and Outlook',
        v: 'Calendars, invitations and the mail thread with the candidate. Reading a calendar, booking on it and sending as you are separate actions with separate answers.',
      },
      {
        k: 'Greenhouse and other applicant systems',
        v: 'In the Easy connect catalogue: click through the OAuth screen and the connection belongs to the workspace. Read the pipeline and the scorecard, write back stage and scheduling. Whether it may write at all is your grant to make.',
      },
      {
        k: 'Notion and Google Drive',
        v: 'The handbook, the scorecards, the onboarding plans. Increasingly these belong in the repo instead, where a change to a policy is a diff with an author and a date on it.',
      },
      {
        k: 'Slack',
        v: 'The one live channel. Policy questions get asked where people already are, and the answer comes back in the thread. Microsoft Teams is shipped but stays off until your deployment turns it on.',
      },
      {
        k: 'Who the connection acts as',
        v: 'One workspace-managed connection the team shares, or a personal authorization where each member acts as themselves and an automated principal cannot act at all. For People systems the second is usually the right answer.',
      },
    ],
    footnote:
      'Easy connect covers 3,000+ apps through their own OAuth screens, and most applicant and HR systems are reached that way. Where one is not, OpenAPI, GraphQL, raw HTTP or a remote MCP server reaches it — and if a system holds data you would rather no agent touched, the correct configuration is not to connect it.',
  },

  cadence: {
    title: 'Ask in the thread. Run onboarding on the start date.',
    sub: 'The same session machinery started three ways. In this function the automated mode is best pointed at logistics with a fixed date, never at anything evaluative.',
    modes: [
      {
        id: 'on-demand',
        label: 'On demand',
        title: '"How much carry-over do I have?"',
        body: 'Asked in a Slack thread, answered from the handbook with the section quoted. Questions the handbook does not answer get routed to a person instead of guessed at.',
      },
      {
        id: 'human-assisted',
        label: 'Human-assisted',
        title: 'It stops before it contacts a candidate',
        body: 'Set anything that sends to a candidate to Ask. The run pauses at the call showing the message and the recipient, and resumes from that exact point once you approve.',
      },
      {
        id: 'automated',
        label: 'Automated',
        title: 'The onboarding run, on the start date',
        body: 'A cron trigger opens the session on day one and works the checklist: accounts requested, reading list assembled, first-week plan drafted, buddy pinged. Fixed date, fixed list, no judgement in it.',
      },
    ],
  },

  control: {
    title: 'Where the line is, and why it is drawn there.',
    sub: 'This is the function where "the agent handled it" would be the wrong answer. The controls below are the platform ones; the first row is the product position.',
    rows: [
      {
        id: 'boundary',
        k: 'It does not decide about people',
        v: 'No ranking, no scoring, no automated rejection, no recommendation dressed as a summary. The jobs on this page are scheduling, drafting, assembling and answering. If you want an agent to screen candidates, that is a decision you are making about your hiring process — and it is not what this page is selling you.',
      },
      {
        id: 'gates',
        k: 'Approval gates are off until you set them',
        v: 'The shipped default is permissive — an action runs unless you have said otherwise. For a People workspace, setting every message to a candidate or an employee to Ask is the first change to make. It is not already done for you.',
      },
      {
        id: 'scope',
        k: 'Reach is granted per agent, not inherited',
        v: 'The recruiting agent reaches the applicant system and the calendar. It does not reach payroll, because you did not list payroll for it — and it cannot discover that the connector exists.',
      },
      {
        id: 'creds',
        k: 'Connector credentials never enter the machine',
        v: 'The sandbox carries one workspace-scoped Kortix token and no third-party keys. Your applicant-system credential is decrypted server-side and attached to the outbound request, then thrown away.',
      },
      {
        id: 'sovereign',
        k: 'Where the data sits is your choice',
        v: 'Kortix is open source and self-hostable: Kortix Cloud, your own VPC, or your own on-prem network. If personal data may not leave your infrastructure, run the whole platform inside it. For deployment and compliance questions, talk to us rather than trusting a claim on a marketing page.',
      },
    ],
  },

  closing: {
    title: 'Take back the week the coordination ate.',
    sub: 'Open source and self-hostable. Any model, your keys. Kortix Cloud, your own VPC, or your own on-prem network.',
  },
};
