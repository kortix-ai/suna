import type { RoleContent } from '../types';

/** Accuracy gate: `../types.ts`. Read it before editing. */
export const engineering: RoleContent = {
  slug: 'engineering',
  name: 'Engineering',
  navDescription: 'Reproduce it, patch it, open the change request',
  seoTitle: 'Kortix for engineering teams',
  seoDescription:
    'Every Kortix session gets its own cloud computer and its own branch. The agent reproduces the bug, writes the patch, runs the tests, and opens a change request. Merge is default-deny for agents.',

  hero: {
    title: 'The work that never reaches the top of the queue.',
    sub: 'Every session boots its own cloud computer, clones the repo, and cuts its own branch. The agent reproduces the failure, writes the patch, runs the suite, and opens a change request. You review a diff, not a transcript.',
    microline: 'One machine per session · one branch per session · merge is default-deny',
    specs: [
      { k: 'Runs on', v: 'A real Linux machine with a shell' },
      { k: 'Works on', v: 'Its own branch, cut per session' },
      { k: 'Lands as', v: 'A change request against main' },
      { k: 'Merge', v: 'Default-deny for agents' },
    ],
  },

  handoff: {
    title: 'The backlog you have stopped pretending you will get to.',
    sub: 'Not the architecture. The long tail underneath it — the reproductions, the bumps, the flakes, the mechanical migration across two hundred files. Work that is well-specified, individually small, and collectively the reason nothing else ships.',
    jobs: [
      {
        id: 'repro',
        title: 'The bug nobody has reproduced',
        body: 'It takes the report, builds the case on its own machine, and comes back with either a failing test or the reason it could not reproduce. A session that cannot reproduce says so. It does not invent a fix for a bug it never saw.',
      },
      {
        id: 'flakes',
        title: 'The flaky test everyone reruns',
        body: 'It runs the suite in a loop, isolates which test actually fails and how often, and finds the shared state or the timing assumption underneath. The change request carries the failure rate it measured before and after.',
      },
      {
        id: 'bumps',
        title: 'Dependency bumps, with the build proved',
        body: 'Upgrade, build, run the suite, read the changelog for the breaking notes, patch the call sites that moved. If the suite goes red it opens the change request anyway, with the failures in the description rather than a green claim.',
      },
      {
        id: 'migration',
        title: 'The mechanical migration across two hundred files',
        body: 'One rename, one API move, one lint rule turned on — the kind of change that is trivial per file and unbearable at scale. It works file by file on its own branch and lands one reviewable diff.',
      },
      {
        id: 'triage',
        title: 'Last night’s exceptions, grouped',
        body: 'It reads the errors the day threw, clusters them by root cause rather than by message, ranks them by how many people hit them, and takes the top one all the way to a patch.',
      },
      {
        id: 'drift',
        title: 'Docs that have drifted from the code',
        body: 'It diffs the documented behaviour against the actual behaviour and corrects the document to match the code, or flags the code as the thing that is wrong. Both are the same commit type here — everything is a file.',
      },
    ],
  },

  output: {
    title: 'A diff on a branch, with the suite already run.',
    sub: 'The output of an engineering session is the thing engineering already reviews. There is no new artifact to learn, no summary to trust — the change is the change, and the tests either passed on the machine that wrote it or they did not.',
    artifact: {
      kind: 'diff',
      file: 'kortix/session-9f4c2b7e · retry backoff jitter',
      lines: [
        ' packages/queue/src/retry.ts',
        '-const delay = base * 2 ** attempt;',
        '+// Full jitter. Without it every worker wakes on the same tick and the',
        '+// retry storm is indistinguishable from the outage that caused it.',
        '+const delay = Math.random() * base * 2 ** attempt;',
        '',
        ' packages/queue/src/retry.test.ts',
        '+test("spreads retries across the window", () => {',
        '+  const spread = sample(1_000).stddev / EXPECTED_MEAN;',
        '+  expect(spread).toBeGreaterThan(0.4);',
        '+});',
      ],
      stat: '2 files · +7 −1 · 214 tests pass',
    },
    caption:
      'Illustration. The branch name is the session id, because that is what a session branch is.',
    notes: [
      {
        id: 'diff',
        title: 'You review the change, not a report about it',
        body: 'The agent commits on the session branch and opens a change request against main. What arrives in review is a diff with a description — the same object a colleague would have opened.',
      },
      {
        id: 'ran',
        title: 'It ran before you read it',
        body: 'The sandbox is a real Linux machine, so the agent installs, builds and runs the suite itself. A change request that arrives red says so in the description rather than claiming green.',
      },
      {
        id: 'preview',
        title: 'One branch, one machine, no collisions',
        body: 'Sessions do not share a working tree. Twenty of them can run against the same repo at once, each on its own branch and its own computer, without stepping on each other.',
      },
    ],
  },

  reach: {
    title: 'The repo, the tracker, the thread.',
    sub: 'An engineering session already has the strongest reach on the platform, because most of the work is inside the repo it cloned. Connectors cover the rest — and every credential is resolved on our side of the wall, never inside the machine.',
    rows: [
      {
        k: 'The repo itself',
        v: 'Cloned into the sandbox at session start, on a fresh branch. The agent has a shell, a filesystem and the full history — it can bisect, run the suite, and read the commit that introduced the line it is about to change.',
      },
      {
        k: 'GitHub',
        v: 'Read issues, comments and the state of a branch, and write back where you have allowed it. Kortix opens the change request itself; the connector is for everything around it.',
      },
      {
        k: 'Linear',
        v: 'Pull the ticket that started the session, read the acceptance criteria, and post back the change request link when the work lands. The ticket stays the source of truth for scope.',
      },
      {
        k: 'Slack',
        v: 'The live channel. Mention the bot in a thread and that thread becomes a session; the answer, and any file it produced, comes back into the same thread. Teams is shipped but off until your deployment turns it on.',
      },
      {
        k: 'Your own services',
        v: 'Point Kortix at an OpenAPI or Postman spec, a GraphQL endpoint, a remote MCP server, or a bare HTTP base URL. It reads the source, works out the authentication, and turns every operation into a tool the agent can call.',
      },
    ],
    footnote:
      'Easy connect covers 3,000+ apps through their OAuth screens. Anything not in that catalogue is reachable through MCP, OpenAPI, GraphQL or raw HTTP — which is usually the honest answer for an internal service, because it never had a public catalogue entry to begin with.',
  },

  cadence: {
    title: 'Ask now, watch the ones that matter, sleep through the rest.',
    sub: 'The same session machinery, started three different ways. Nothing about the isolation or the review changes with the trigger.',
    modes: [
      {
        id: 'on-demand',
        label: 'On demand',
        title: 'From the thread you are already in',
        body: 'Describe the bug in a Slack thread, or start a session from the web app or the CLI. You get a reaction on your own message rather than a bot post, and the reply lands in the same thread.',
      },
      {
        id: 'human-assisted',
        label: 'Human-assisted',
        title: 'It stops where you told it to stop',
        body: 'Set an action to Ask and the run pauses at the call and waits, showing you the action and its arguments. Approve and the same call completes and the session carries on from exactly where it stopped.',
      },
      {
        id: 'automated',
        label: 'Automated',
        title: 'A cron, or a signed webhook off your own alerts',
        body: 'Triage the overnight exceptions at 06:00. Or wire your alerting to a signed webhook so a paging event starts a session with the incident payload already in the prompt.',
      },
    ],
  },

  control: {
    title: 'Nothing merges itself.',
    sub: 'The interesting question about an autonomous engineer is not what it can write. It is what it can land. Here is the answer, stated exactly.',
    rows: [
      {
        id: 'merge',
        k: 'Merge is default-deny',
        v: 'An agent cannot merge to main. The permission exists — an admin can grant project.cr.merge — but the grant lives in kortix.yaml, so widening it is itself a change someone reviews. Nothing about that is a hidden default.',
      },
      {
        id: 'gates',
        k: 'Approval gates are off until you set them',
        v: 'The shipped default is permissive: actions run unless you say otherwise. Set Ask on the ones that should pause and Block on the ones that should never happen, per action or with one pattern rule. We would rather tell you the default than let you assume the safer one.',
      },
      {
        id: 'isolation',
        k: 'Each session is walled off from the others',
        v: 'One disposable Linux machine per session, on its own branch. The only thing genuinely shared is the world outside — which is why the connectors, not the machine, are where reach is decided.',
      },
      {
        id: 'creds',
        k: 'Connector credentials never enter the machine',
        v: 'The sandbox carries one project-scoped Kortix token and no third-party keys. The gateway decrypts the real credential server-side and attaches it to the outbound call. A runtime secret you deliberately grant is different — that one is a real environment value the agent can read, and it is meant to be.',
      },
      {
        id: 'audit',
        k: 'Every tool call is written down',
        v: 'The gateway that resolves the credential is the same thing that writes the record: the action, the agent, the person or trigger behind the session, the outcome, and who released a held call.',
      },
    ],
  },

  closing: {
    title: 'Give it the ticket nobody picked up.',
    sub: 'Open source and self-hostable. Any model, your keys. Kortix Cloud, your own VPC, or your own on-prem network.',
  },
};
