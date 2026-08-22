import type { RoleContent } from '../types';

/** Accuracy gate: `../types.ts`. Read it before editing. */
export const marketing: RoleContent = {
  slug: 'marketing',
  name: 'Marketing',
  navDescription: 'Production work that sounds like you, because the voice is a file',
  seoTitle: 'Kortix for marketing teams',
  seoDescription:
    'Your voice, your claims and your banned words live in the repo as a skill file every session reads. Marketing work lands as a draft in a change request, so the review is a diff.',

  hero: {
    title: 'It sounds like you because your voice is a file it has to read.',
    sub: 'AI copy reads like AI copy because nothing told it how you write. Here your voice, your claims and your banned words live in the repo, and every session loads them before writing a word.',
    microline: 'The voice is a file · the claims are a file · every draft is a diff',
    specs: [
      { k: 'Voice lives in', v: 'A skill file in your repo' },
      { k: 'Every session', v: 'Reads it before writing' },
      { k: 'Lands as', v: 'A draft in a change request' },
      { k: 'Improves by', v: 'Editing the file, not re-prompting' },
    ],
  },

  handoff: {
    title: 'The production line, not the idea.',
    sub: 'Strategy is not the bottleneck. One positioning decision turns into nine assets, and by the third one the voice has drifted and nobody has time to notice.',
    jobs: [
      {
        id: 'variants',
        title: 'One decision, all nine assets',
        body: 'A launch note, the page section, the changelog entry, the social copy, the email. Written from the same source of truth in one session, so they agree with each other — which is usually the actual failure, not the quality of any single one.',
      },
      {
        id: 'brief',
        title: 'The content brief with the research already done',
        body: 'What has been published on the subject, what your own site already says about it, what you have said before that this would contradict. The brief starts from what exists rather than from a blank page.',
      },
      {
        id: 'audit',
        title: 'The claim audit across your own site',
        body: 'It reads every page and finds where the copy claims something the product does not do, or says it three different ways. This is the job nobody schedules and everybody needs, and it is a diff when it is done.',
      },
      {
        id: 'competitive',
        title: 'The competitive watch, without the manufactured finding',
        body: 'A scheduled session reads what has publicly changed and reports what is genuinely new — and says plainly when nothing is. A weekly digest that invents a headline every week gets muted by week five.',
      },
      {
        id: 'repurpose',
        title: 'One long piece into the formats it should have been',
        body: 'The talk becomes a post, the post becomes the thread, the thread becomes the email. Each one written for its surface rather than the same text pasted four times with the line breaks moved.',
      },
      {
        id: 'reporting',
        title: 'The campaign read-out',
        body: 'It pulls what ran and what happened, writes the honest version including the parts that did not work, and drafts what it would change. Attribution stays a judgement call — it presents the numbers, it does not decide what caused them.',
      },
    ],
  },

  output: {
    title: 'A draft on a branch, reviewed as a diff.',
    sub: 'Marketing review usually means pasting a document into a comment thread and losing track of which version won. Here every draft is a commit, so review is a diff and the history is real.',
    artifact: {
      kind: 'doc',
      file: 'content/launch/2026-07-scheduled-sessions.md',
      title: 'Scheduled sessions — launch note draft',
      meta: [
        { k: 'Voice', v: 'skills/voice/SKILL.md' },
        { k: 'Claims', v: 'skills/claims/SKILL.md' },
        { k: 'Status', v: 'Draft · for review' },
        { k: 'Flagged', v: '2 claims, unverified' },
      ],
      lines: [
        'A trigger fires at 07:00. A session starts, does the work on its own machine, and opens a change request before anyone is at a desk. That is the whole feature.',
        'Two lines in this draft are flagged, not written: a throughput figure and a comparison to a competitor’s scheduling. Neither traces to a source in the repo, so the agent left the claim marked rather than filling the sentence in.',
        'Banned by the voice file and therefore absent: “seamless”, “unlock”, “revolutionary”, and every superlative except the one form the file permits.',
      ],
    },
    caption:
      'Illustration. The paths are the real shape of a Kortix project, the copy is fictional.',
    notes: [
      {
        id: 'voice',
        title: 'The voice is code, so fixing it is a commit',
        body: 'When a draft comes back wrong, you edit the skill file, not the prompt. Every future session in every project that loads that skill inherits the correction — and you can see in the history exactly when the register changed.',
      },
      {
        id: 'claims',
        title: 'It flags what it cannot substantiate',
        body: 'A claims file lists what you are allowed to say and what needs a source. An agent that hits an unsupported claim marks it rather than writing a confident sentence — which is the single most useful behaviour you can configure in this function.',
      },
      {
        id: 'diff',
        title: 'Review is a diff, not a comment thread',
        body: 'Two drafts of the same page are two commits. What changed between them is a diff you can read in ten seconds, instead of a document with eleven suggestion bubbles and no clear current version.',
      },
    ],
  },

  reach: {
    title: 'Where the words live, and where they have to go.',
    sub: 'Connect each source once for the whole project. Credentials are decrypted on our side and attached to the outgoing call. They never land in the machine the model is driving.',
    rows: [
      {
        k: 'Notion and Google Drive',
        v: 'The brief, the positioning doc, the six months of decisions nobody wrote down anywhere else. It reads them as prior art before it writes, and puts the finished draft back where the team looks.',
      },
      {
        k: 'GitHub',
        v: 'If your site is a repo, the copy is code — and a copy change is a change request with a preview, reviewed exactly like a code change, by whoever owns the words.',
      },
      {
        k: 'Your email and campaign tools',
        v: 'The marketing stack is broad and the Easy connect catalogue is where most of it is: click the app, click through its OAuth screen, done. Sending is an action you can set to Ask so nothing reaches a list without a person.',
      },
      {
        k: 'Google Sheets',
        v: 'The campaign tracker, the keyword sheet, the calendar the whole team actually edits. It reads them as input and writes the read-out back into them.',
      },
      {
        k: 'Slack',
        v: 'The one live channel. Ask for the variant in the thread where the launch is being argued about, and the draft comes back into that thread as a file.',
      },
    ],
    footnote:
      'Easy connect covers 3,000+ apps through their own OAuth screens. Where a tool is not in the catalogue, it is reachable through OpenAPI, a Postman collection, GraphQL, raw HTTP or a remote MCP server — the same three-minute setup, one step less magic.',
  },

  cadence: {
    title: 'Draft it now. Never let it send by itself.',
    sub: 'Three ways to start the same session. Scheduled runs need the most care here, because the output is public.',
    modes: [
      {
        id: 'on-demand',
        label: 'On demand',
        title: '"Give me the four variants"',
        body: 'Ask in a thread and the session reads the source, the voice file and the claims file, then comes back with the drafts in the same thread.',
      },
      {
        id: 'human-assisted',
        label: 'Human-assisted',
        title: 'It stops before anything is published',
        body: 'Set the publish and send actions to Ask. The run pauses at the call with the exact payload in front of you — the list, the subject, the body — and resumes from that point when you approve.',
      },
      {
        id: 'automated',
        label: 'Automated',
        title: 'Research on a schedule, publishing never',
        body: 'Run the competitive watch and the claim audit on a cron and let them land as change requests. Automating the reading is a clear win; automating the publishing is how a wrong claim goes out at 03:00 with nobody awake.',
      },
    ],
  },

  control: {
    title: 'Nothing published, nothing claimed, without a person.',
    sub: 'A mistake in marketing is public and permanent. So the defaults below are stated precisely, not reassuringly.',
    rows: [
      {
        id: 'gates',
        k: 'Approval gates are off until you set them',
        v: 'The shipped default is permissive — an action runs unless you have said otherwise. For a marketing project, setting every publish and every send to Ask is the first change you make. It is not already done for you, and we would rather say so.',
      },
      {
        id: 'merge',
        k: 'Merge is default-deny',
        v: 'A draft lands on the session branch and reaches main through a change request. An agent cannot merge unless an admin has granted project.cr.merge in kortix.yaml, and widening that grant is itself a reviewed change. Nothing goes live because a session decided it was finished.',
      },
      {
        id: 'claims',
        k: 'The claims file is the substance of the control',
        v: 'Permissions stop an agent doing something. A claims skill stops it saying something. Both live in the repo, and the second one is what actually keeps an unverifiable number off your homepage.',
      },
      {
        id: 'creds',
        k: 'Connector credentials never enter the machine',
        v: 'The sandbox carries one project-scoped Kortix token and no third-party keys. The credential for your campaign tool is decrypted server-side and attached to the outbound request.',
      },
      {
        id: 'audit',
        k: 'Every call it made, and who let it',
        v: 'The connector and exact action, the agent, the person or trigger behind the session, the outcome, and who released a held call. If something went out, the record says who released it.',
      },
    ],
  },

  closing: {
    title: 'Put the voice in the repo. Let the production line run.',
    sub: 'Open source and self-hostable. Any model, your keys. Kortix Cloud, your own VPC, or your own on-prem network.',
  },
};
