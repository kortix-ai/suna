/**
 * The sections under the hero of /slack and /teams,
 * in Kortix's bordered layout. The hero itself is `content.ts`.
 *
 * ACCURACY GATE (checked against apps/api/src/channels/{slack,teams}/*,
 * 2026-10-26). Never claim, on either page:
 *  - bare "one click" for Slack: the app is added, invited, then mentioned;
 *  - slash commands in Slack's Assistant pane or threads;
 *  - Teams reactions, message search, non-image files in group chats, or a
 *    self-serve Teams install without a tenant admin;
 *  - customer quotes, logos or numbers (none approved yet: no testimonials).
 */

import { localizeUiCatalog } from '@kortix/ui/i18n';
import { REMAINING_UI_TRANSLATION_KEYS } from '@kortix/ui/i18n/ui-catalog/remaining-ui-translation-keys.generated';
import type { UiTranslator } from '@/i18n/translator';

import type { ChatCard, ChatMessage } from './chat';

export type ChannelId = 'slack' | 'teams';

type TwoTone = { title: string; titleMuted: string };

export type StepVisual =
  | { kind: 'install'; rows: readonly { label: string; detail: string }[] }
  | { kind: 'message'; message: ChatMessage }
  | { kind: 'card'; card: ChatCard };

export type ChannelContent = {
  id: ChannelId;
  /** The hero window's thread. */
  window: readonly ChatMessage[];
  statement: TwoTone & { cta: { label: string; href: string } };
  together: TwoTone & {
    body: readonly string[];
    fact: { k: string; v: string };
    channel: string;
    messages: readonly ChatMessage[];
  };
  traits: TwoTone & { items: readonly (TwoTone & { line: string; card: ChatCard })[] };
  compare: TwoTone & {
    sub: string;
    tabs: readonly { id: string; label: string; chatbot: string; kortix: string; artifact: string }[];
  };
  steps: TwoTone & { items: readonly { title: string; body: string; visual: StepVisual }[] };
  control: TwoTone & {
    body: string;
    checks: readonly string[];
    link: { label: string; href: string };
    channel: string;
    messages: readonly ChatMessage[];
  };
  faq: TwoTone & { items: readonly { q: string; a: string }[] };
};

const FIX_STEPS: ChatCard = {
  kind: 'steps',
  title: 'Working · 3 steps',
  steps: [
    { label: 'grep apps/api/src/billing', done: true },
    { label: 'edit webhook-retry.ts', done: true },
    { label: 'bun test apps/api/src/billing', done: false },
  ],
  stop: true,
};

const SLACK: ChannelContent = {
  id: 'slack',
  window: [
    {
      from: 'you',
      name: 'Sam',
      time: '9:14',
      text: '@Kortix checkout is throwing 500s since the deploy. Find out why and fix it.',
    },
    { from: 'kortix', name: 'Kortix', time: '9:14', text: 'On it, in a session of its own for this thread.', card: FIX_STEPS },
    {
      from: 'kortix',
      name: 'Kortix',
      time: '9:19',
      text: 'Found it: every non-2xx retried, so a 404 burned all five attempts. Fixed, and the suite passes: 3 pass, 0 fail.',
      card: {
        kind: 'ask',
        title: 'Change request: stop retrying webhooks on a 4xx',
        detail: '2 files changed',
        actions: [{ label: 'Ship it', primary: true }, { label: 'Ask for changes' }, { label: 'Reject' }],
      },
    },
  ],
  statement: {
    title: 'Your team asks in Slack.',
    titleMuted: 'The work comes back reviewed.',
    cta: { label: 'Connect Slack', href: '/auth' },
  },
  together: {
    title: 'One thread, one session.',
    titleMuted: 'People and agents, in the same conversation.',
    body: [
      'Mention Kortix in a channel or send it a DM. The thread becomes a session that runs on its own machine, and its progress streams back into the thread.',
      'Reply in the thread to steer it. A follow-up continues the same session, even after its machine has slept.',
    ],
    fact: { k: 'In a DM', v: 'Every message reaches the agent. In a channel, only a mention does.' },
    channel: '# incidents',
    messages: [
      { from: 'you', name: 'Priya', time: '10:02', text: '@Kortix the nightly export failed. What changed?' },
      {
        from: 'kortix',
        name: 'Kortix',
        time: '10:04',
        text: 'The export job ran out of memory after yesterday’s schema change. I opened a change request that streams the rows instead.',
      },
      { from: 'you', name: 'Priya', time: '10:06', text: 'Good. Run it once against staging before I ship it.' },
    ],
  },
  traits: {
    title: 'What it does in Slack.',
    titleMuted: 'Three things a chatbot does not.',
    items: [
      {
        title: 'Streams',
        titleMuted: 'its progress.',
        line: 'Each step lands in the thread as it runs, with a Stop button.',
        card: FIX_STEPS,
      },
      {
        title: 'Asks',
        titleMuted: 'before it acts.',
        line: 'Change requests and connector calls arrive as cards. A person decides.',
        card: {
          kind: 'ask',
          title: 'Allow Kortix to call Stripe?',
          detail: 'Refund order 4821 · €49.00',
          actions: [{ label: 'Approve', primary: true }, { label: 'Deny' }],
        },
      },
      {
        title: 'Runs',
        titleMuted: 'as you.',
        line: 'Each person signs in once. A run uses the sender’s permissions.',
        card: {
          kind: 'ask',
          title: '/kortix login',
          detail: 'Signed in. Runs from this account now use your permissions.',
          actions: [{ label: 'Open Kortix' }],
        },
      },
    ],
  },
  compare: {
    title: 'A chatbot answers.',
    titleMuted: 'Kortix does the work.',
    sub: 'Other assistants hand you a plan. Kortix runs it on its own machine and posts the result to the thread.',
    tabs: [
      {
        id: 'incident',
        label: 'Failing deploy',
        chatbot: 'Lists five things that might cause 500s.',
        kortix: 'Finds the cause, fixes it, opens a change request.',
        artifact: 'Change request · 2 files',
      },
      {
        id: 'report',
        label: 'Weekly report',
        chatbot: 'Tells you which numbers to pull.',
        kortix: 'Pulls them and posts the report.',
        artifact: 'weekly-report.pdf',
      },
      {
        id: 'refund',
        label: 'Refund request',
        chatbot: 'Explains how refunds work.',
        kortix: 'Checks your refund rules and asks to approve the refund.',
        artifact: 'Approval card · €49.00',
      },
    ],
  },
  steps: {
    title: 'Live in three steps.',
    titleMuted: 'No new tool to learn.',
    items: [
      {
        title: 'Add Kortix to Slack',
        body: 'Connect it from your project with OAuth, or bring your own Slack app.',
        visual: {
          kind: 'install',
          rows: [
            { label: 'Add to Slack', detail: 'OAuth' },
            { label: 'Your own Slack app', detail: 'kortix channels manifest' },
          ],
        },
      },
      {
        title: 'Invite it, mention it',
        body: 'Invite the bot to a channel and mention it with a task. Or send it a DM.',
        visual: {
          kind: 'message',
          message: { from: 'you', name: 'Sam', time: '9:14', text: '@Kortix draft the weekly pipeline summary.' },
        },
      },
      {
        title: 'Approve in the thread',
        body: 'The result comes back as a card. Ship it, ask for changes, or reject it.',
        visual: {
          kind: 'card',
          card: {
            kind: 'ask',
            title: 'Weekly pipeline summary',
            detail: 'Ready for review',
            actions: [{ label: 'Ship it', primary: true }, { label: 'Reject' }],
          },
        },
      },
    ],
  },
  control: {
    title: 'Autonomous,',
    titleMuted: 'not unsupervised.',
    body: 'Kortix works where it is invited, as the person who asked, and nothing it changes lands until a person approves it.',
    checks: [
      'It reads a channel only when invited, and answers only a mention there.',
      'Change requests and connector calls wait for a person.',
      'Each run uses the permissions of the person who asked.',
    ],
    link: { label: 'Read about security', href: '/security' },
    channel: '# eng',
    messages: [
      { from: 'you', name: 'Alex', time: '11:20', text: '@Kortix push the hotfix straight to main.' },
      {
        from: 'kortix',
        name: 'Kortix',
        time: '11:21',
        text: 'I opened it as a change request instead: main only takes reviewed changes.',
        card: {
          kind: 'ask',
          title: 'Hotfix: guard empty invoices',
          detail: '1 file · tests pass',
          actions: [{ label: 'Ship it', primary: true }, { label: 'Reject' }],
        },
      },
    ],
  },
  faq: {
    title: 'Questions.',
    titleMuted: 'Answered from the code.',
    items: [
      {
        q: 'Does Kortix read every message in a channel?',
        a: 'No. In a channel it answers only when mentioned, and only in channels it was invited to. In a DM, every message reaches it.',
      },
      {
        q: 'Does it run as a shared bot?',
        a: 'Each person runs /kortix login once. From then on a run uses that person’s own Kortix permissions, and personal keys stay in DMs.',
      },
      {
        q: 'Can one workspace serve several projects?',
        a: 'Yes. Set the project, agent, model and who may join per channel with /kortix.',
      },
      {
        q: 'Can we use our own Slack app?',
        a: 'Yes. Generate the manifest with kortix channels manifest, create the app, then connect it with its bot token and signing secret.',
      },
      {
        q: 'Does it work with a self-hosted Kortix?',
        a: 'Yes. A self-hosted instance uses its own Slack app credentials.',
      },
    ],
  },
};

const TEAMS: ChannelContent = {
  id: 'teams',
  window: [
    {
      from: 'you',
      name: 'Sam',
      time: '9:14',
      text: '@Kortix checkout is throwing 500s since the deploy. Find out why and fix it.',
    },
    { from: 'kortix', name: 'Kortix', time: '9:14', text: 'On it.', card: FIX_STEPS },
    {
      from: 'kortix',
      name: 'Kortix',
      time: '9:19',
      text: 'Found it: every non-2xx retried, so a 404 burned all five attempts. Fixed: 3 pass, 0 fail.',
      card: {
        kind: 'ask',
        title: 'Change request: stop retrying webhooks on a 4xx',
        detail: '2 files changed',
        feedback: 'Add feedback (optional)',
        actions: [{ label: 'Approve', primary: true }, { label: 'Deny' }],
      },
    },
  ],
  statement: {
    title: 'Your team asks in Teams.',
    titleMuted: 'The work comes back reviewed.',
    cta: { label: 'Connect Teams', href: '/auth' },
  },
  together: {
    title: 'Where your team already talks.',
    titleMuted: 'Chats, group chats and channels.',
    body: [
      'In a personal chat every message reaches the agent, one session until /new. In a group chat a mention starts it and replies continue it. In a channel, each post is its own session.',
      'One live card shows the steps, then the reply. Type /stop to end a run.',
    ],
    fact: { k: 'Private replies', v: 'Some answers are visible only to the person who asked.' },
    channel: 'Billing · General',
    messages: [
      { from: 'you', name: 'Priya', time: '10:02', text: '@Kortix the nightly export failed. What changed?' },
      {
        from: 'kortix',
        name: 'Kortix',
        time: '10:04',
        text: 'The export job ran out of memory after yesterday’s schema change. I opened a change request that streams the rows instead.',
      },
    ],
  },
  traits: {
    title: 'What it does in Teams.',
    titleMuted: 'Three things a chatbot does not.',
    items: [
      {
        title: 'Shows',
        titleMuted: 'its work.',
        line: 'One live card shows each step, then the reply.',
        card: FIX_STEPS,
      },
      {
        title: 'Asks',
        titleMuted: 'before it acts.',
        line: 'Approval cards for change requests and connector calls, with room for feedback.',
        card: {
          kind: 'ask',
          title: 'Allow Kortix to call Stripe?',
          detail: 'Refund order 4821 · €49.00',
          feedback: 'Add feedback (optional)',
          actions: [{ label: 'Approve', primary: true }, { label: 'Deny' }],
        },
      },
      {
        title: 'Files',
        titleMuted: 'land where they belong.',
        line: 'Images show inline. Other files go to OneDrive in a chat and SharePoint in a channel.',
        card: {
          kind: 'ask',
          title: 'weekly-report.pdf',
          detail: 'Saved to the channel’s SharePoint files',
          actions: [{ label: 'Open' }],
        },
      },
    ],
  },
  compare: SLACK.compare,
  steps: {
    title: 'One consent,',
    titleMuted: 'then everyone.',
    items: [
      {
        title: 'An admin grants consent',
        body: 'A tenant admin approves Kortix once, for the whole organization.',
        visual: {
          kind: 'card',
          card: {
            kind: 'ask',
            title: 'Kortix wants permission for your organization',
            detail: 'Requested by a tenant admin',
            actions: [{ label: 'Accept', primary: true }, { label: 'Cancel' }],
          },
        },
      },
      {
        title: 'Add it from your apps',
        body: 'Kortix appears in your organization’s app catalog. Anyone adds it to a chat or a team.',
        visual: {
          kind: 'install',
          rows: [
            { label: 'Add to Teams', detail: 'Org catalog' },
            { label: 'Your own Azure Bot', detail: 'App ID and secret' },
          ],
        },
      },
      {
        title: 'Each person signs in',
        body: 'Run /login once, so a run uses your own permissions.',
        visual: {
          kind: 'message',
          message: { from: 'you', name: 'Sam', time: '9:14', text: '/login' },
        },
      },
    ],
  },
  control: { ...SLACK.control, channel: 'Engineering · General' },
  faq: {
    title: 'Questions.',
    titleMuted: 'Answered from the code.',
    items: [
      {
        q: 'Do we need a Teams admin?',
        a: 'Yes, once. A tenant admin grants consent, and Kortix is published to your organization’s app catalog. After that, anyone adds it.',
      },
      {
        q: 'How does it behave in a chat versus a channel?',
        a: 'In a personal chat every message reaches it, one session until /new. In a group chat a mention starts it. In a channel each post is its own session.',
      },
      {
        q: 'Where do files go?',
        a: 'Images show inline everywhere. In a personal chat, other files arrive in OneDrive after you accept them. In a channel, they go to the team’s SharePoint files.',
      },
      {
        q: 'Can we use our own bot?',
        a: 'Yes. Bring your own Azure Bot with its app ID, secret and tenant, then upload the manifest.',
      },
      {
        q: 'Does it support reactions or message search?',
        a: 'Not yet. Long replies are cut in Teams and link to the full session.',
      },
    ],
  },
};

const CHANNELS: Record<ChannelId, ChannelContent> = { slack: SLACK, teams: TEAMS };

export function channelContent(id: ChannelId): ChannelContent {
  return CHANNELS[id];
}

export function getLocalizedChannel(id: ChannelId, tI18nComplete: UiTranslator): ChannelContent {
  return localizeUiCatalog(CHANNELS[id], tI18nComplete, REMAINING_UI_TRANSLATION_KEYS);
}
