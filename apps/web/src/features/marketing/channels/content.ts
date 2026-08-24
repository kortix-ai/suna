/**
 * `/channels` copy.
 *
 * Plain English lives here, not in `apps/web/translations/*.json`, so the copy
 * can iterate before paying the 8-locale parity gate (`pnpm i18n:translations`).
 * Wire i18n keys only once the copy is locked.
 *
 * Voice rules: the `comms` skill.
 *
 * ==========================================================================
 * ACCURACY GATE — read this before editing one word of the surface list.
 * ==========================================================================
 * The `comms` glossary calls a channel "Slack, Teams, Telegram, WhatsApp, SMS,
 * email". THE PRODUCT DOES NOT. Verified against the code, not the pitch:
 *
 *  - `packages/manifest-schema/src/constants.ts`:
 *      `export const CHANNEL_PLATFORMS = ['slack', 'teams', 'email', 'voice']`
 *    Four values. It is a closed enum — `json-schema.ts` emits it as
 *    `enum: [...CHANNEL_PLATFORMS]`, so an unknown platform fails validation.
 *
 *  - SLACK is the only channel live with no gate. `channels-view.tsx` always
 *    renders the row. One-click install needs SLACK_CLIENT_ID/SECRET/
 *    SIGNING_SECRET on the server (`slack-oauth-mode.ts`); without them the UI
 *    falls back to a paste-your-own-app-manifest flow. Either way the bot still
 *    has to be invited to a channel and @-mentioned. Do NOT write bare
 *    "one click" — write what actually happens.
 *
 *  - MICROSOFT TEAMS is code-complete but OFF BY DEFAULT.
 *    `apps/api/src/config.ts`: `TEAMS_CHANNEL_ENABLED: optBoolFalse`, and the
 *    key is absent from `apps/api/.env` and `.env.dev` (checked with
 *    `dotenvx get` → MISSING_KEY). `channels-view.tsx:591`: `if (mode &&
 *    !mode.enabled) return null` — the row does not render at all. The connect
 *    route 404s. The CLI cannot disconnect it. It is NOT "live". Label it as
 *    what it is: shipped, and switched on by the operator.
 *
 *  - EMAIL and VOICE are `stability: 'experimental'` with
 *    `platformDefault: () => false` (`apps/api/src/experimental/features.ts`).
 *    Per-project opt-in. Voice is not even a Channels row — it is its own rail
 *    item. `join_gmeet` / `join_zoom` are declared and NOT IMPLEMENTED.
 *
 *  - TELEGRAM, WHATSAPP, SMS, DISCORD ARE NOT CHANNELS. Telegram has an inbound
 *    webhook only: its sender gate defaults on with no way to configure the
 *    allowlist, so it rejects everyone, and the reply CLI it tells the agent to
 *    run does not exist in `apps/sandbox/slack-cli/channels/`. WhatsApp, SMS
 *    and Discord are greyed-out "Coming Soon" chips in the mobile app with zero
 *    backend. Do not list any of them as a channel, in any tense.
 *
 *  - THERE IS NO BUILD-YOUR-OWN-CHANNEL API. No route, no doc, no spec. The
 *    closest real thing is a signed webhook trigger, which starts and buckets
 *    sessions but gives you NO thread mapping and NO reply relay — you write
 *    the outbound leg yourself. Say exactly that. See `custom` below.
 *
 * Other rules:
 *  - Say "agent computer" / "cloud computer" / "sandbox". NEVER "container".
 *  - Never claim a certification. Never name a licence — "open source" and stop.
 *  - Slack carries Review Center cards and a deep link, NOT the git diff. Do not
 *    write "review the change request in Slack".
 */

export const hero = {
  eyebrow: 'Channels',
  title: 'Reach it where people already work.',
  sub: 'Connect Slack to a project and a message in a thread starts a session. The agent picks up its own cloud computer, does the work, and answers in the same thread. Nobody has to open a new tool to ask for something.',
  ctaPrimary: 'Connect Slack',
  ctaPrimaryHref: '/auth',
  ctaSecondary: 'Read the docs',
  ctaSecondaryHref: '/docs/connect/slack',
  microline: 'Slack today · Teams and email behind a switch',
  /** Four mono facts under the fold. Every value has to be defensible. */
  specs: [
    { k: 'Live today', v: 'Slack', visual: 'presence' },
    { k: 'A thread is', v: 'Exactly one session', visual: 'thread' },
    { k: 'The reply lands', v: 'In the same thread', visual: 'reply' },
    { k: 'Approve or deny', v: 'On a card, in the thread', visual: 'approve' },
  ],
} as const;

export const surfaces = {
  eyebrow: 'The surfaces',
  title: 'One is live. Three are behind a switch. We will say which.',
  sub: 'A channel is a chat platform bound to a project — a closed set of four, not an open field. Here is the real state of each one, including the parts a marketing page usually leaves out.',
  columns: ['Surface', 'State', 'What that means'] as const,
  /** `icon` keys map to `features/icon`. `state` is the honest one. */
  rows: [
    {
      id: 'slack',
      icon: 'Slack',
      name: 'Slack',
      state: 'Live',
      body: 'On by default, no flag. Connect from the dashboard or the CLI, invite the bot to a channel, and mention it. Everything else on this page describes Slack.',
    },
    {
      id: 'teams',
      icon: 'MicrosoftTeams',
      name: 'Microsoft Teams',
      state: 'Operator switch',
      body: 'Code complete and off by default. Your deployment turns it on and supplies Microsoft app credentials; a tenant admin then consents once. Same sessions, same identity rules as Slack.',
    },
    {
      id: 'email',
      icon: 'Gmail',
      name: 'Email',
      state: 'Experimental',
      body: 'A project inbox, so a message to an address starts a session and a reply continues it. Opt in per project under Customize → Feature flags. Real, and not finished.',
    },
  ],
  notChannels: {
    title: 'What is not a channel',
    body: 'Telegram, WhatsApp, SMS and Discord are not channels, and this page will not imply they are on a roadmap it cannot promise. There is also no build-your-own-channel API — the platform list is a closed enum. What there is instead is a signed webhook trigger, and we would rather tell you its limits than sell you the word "extensible".',
    linkLabel: 'The honest alternative →',
    linkHref: '#custom',
  },
} as const;

export const thread = {
  eyebrow: 'Thread to session',
  title: 'A thread is a session. One, and only one.',
  sub: 'The first message in a thread creates a session. Every later message in that thread reaches the same session — after the sandbox stops overnight, after the person who started it goes home. That mapping is a unique index in the database, not a convention two services agree to honour.',
  steps: [
    {
      n: '00',
      title: 'Someone mentions the bot',
      body: 'In a channel it has been invited to, or in a direct message. A bare mention with no task gets a reminder to add one, rather than a session nobody asked for.',
    },
    {
      n: '01',
      title: 'A session starts',
      body: 'Kortix cuts a branch and boots its own isolated cloud computer, exactly as it would for a session started from the dashboard or the CLI. You get a reaction on your own message, not a bot post saying “on it”.',
    },
    {
      n: '02',
      title: 'The agent works',
      body: 'It has a shell, a filesystem, the network, and whichever connectors and secrets its agent block grants it. The thread is where you watch. The machine is where the work happens.',
    },
    {
      n: '03',
      title: 'It answers in the thread',
      body: 'The reply streams into the message it started, in the thread the question was asked in. Two people can watch. Neither had to open anything.',
    },
  ],
  footnote:
    'Two events for the same brand-new thread arriving at once do not produce two sessions: the second joins the first and is delivered as a follow-up. One Slack workspace bound to more than one project shows a project picker on the first mention instead of guessing.',
  /**
   * The illustrated thread. Fictional workspace and people only — Acme,
   * Northwind, Globex. Never a real customer, never a real colleague.
   * The session id reads as a truncated UUID because that is what a branch
   * name actually is; do not invent a prettier scheme.
   */
  mock: {
    channel: '#acme-launch',
    turns: [
      {
        id: 'ask',
        who: 'Dana',
        kind: 'person',
        text: '@kortix draft the Q3 launch note from the changelog and put it in the repo',
      },
      {
        id: 'work',
        who: 'kortix',
        kind: 'agent',
        text: 'Reading the changelog since v0.9. Drafting launch-note.md on this session’s branch.',
      },
      {
        id: 'file',
        who: 'kortix',
        kind: 'file',
        text: 'launch-note.md',
      },
    ],
    system: {
      label: 'session',
      id: '9f4c2b7e',
      note: 'cloud computer booted · branch cut · agent running',
    },
    review: {
      title: 'Open a change request against main?',
      body: 'launch-note.md · +64 −0',
      actions: ['Approve', 'Ask for changes', 'Deny'],
    },
    caption: 'Illustration. Acme is a placeholder, not a customer.',
  },
} as const;

export const connect = {
  eyebrow: 'Connect it',
  title: 'Install it, invite it, mention it.',
  sub: 'On a host with the shared Slack app configured, kortix channels connect prints an install link and you are three clicks from done. On a deployment with no shared app, the same command falls back to manual mode by itself and hands you an app manifest to paste.',
  shell: {
    title: 'kortix channels',
    lines: [
      '# managed: an install link, then pick the workspace',
      '$ kortix channels connect --wait',
      '→ connected: slack workspace acme-hq',
      '',
      '# self-hosting? the same command falls back to manual',
      '$ kortix channels manifest > slack-app.json',
      '$ kortix channels connect --manual \\',
      '    --bot-token xoxb-... --signing-secret ...',
      '',
      '# check it, or take it away',
      '$ kortix channels status',
      '$ kortix channels disconnect',
    ],
  },
  notes: [
    'Installing is not the last step: invite the bot to a channel and mention it. Nothing happens in a channel it has not been invited to.',
    'Connecting writes a channel connector into kortix.yaml for you. You never hand-write that entry.',
    'The dashboard uses the same install flow as the CLI. Neither one is the real one.',
  ],
} as const;

export const back = {
  eyebrow: 'The round trip',
  title: 'What comes back is the work, not a transcript.',
  sub: 'A channel is only worth connecting if the answer arrives where the question was asked. Files go both directions, and the decisions an agent needs from you are buttons in the thread rather than a link to somewhere else.',
  cards: [
    {
      id: 'answer',
      title: 'The answer, streamed',
      body: 'The reply lands in the thread as one message that fills in, not a wall of updates. The agent finalises that message rather than posting a second one underneath it.',
    },
    {
      id: 'files',
      title: 'Files, both directions',
      body: 'A file dropped in the thread is pulled into the agent’s cloud computer. A file the agent produces is uploaded back into the same thread. The deck lands where you asked for the deck.',
    },
    {
      id: 'review',
      title: 'Approve, deny, ask for changes',
      body: 'When the agent needs a decision, it posts a card with buttons instead of blocking a turn forever. Your click is the verdict, and the session resumes from it in the same thread.',
    },
  ],
  footnote:
    'One honest limit: the card carries the decision and a link back into Kortix. Reading the actual diff of a change request happens in the web app, where a diff belongs — Slack is not a code review tool and we are not going to pretend it is.',
} as const;

export const commands = {
  eyebrow: 'From the thread',
  title: 'Run the project without leaving the conversation.',
  sub: 'Type these as /kortix <command> in Slack, or as plain text in a direct message. Most of what you would otherwise open the dashboard for is one line in the channel.',
  columns: ['Command', 'What it does'] as const,
  rows: [
    { cmd: 'login, logout', v: 'Link or unlink your chat identity to your Kortix account' },
    { cmd: 'switch, unbind', v: 'Rebind this channel to a different project, or unbind it' },
    { cmd: 'projects', v: 'List the projects you can bind this channel to' },
    { cmd: 'sessions', v: 'List the recent sessions started from this workspace' },
    { cmd: 'agent <name>, model <id>', v: 'Set the agent and the model this channel uses' },
    { cmd: 'policy <mode>', v: 'Set who may start a session here' },
    { cmd: 'whoami', v: 'Show the panel: project, agent, model, policy, linked identity' },
  ],
  policy: {
    title: 'Three answers to “who may start a session here”',
    values: [
      {
        k: 'project_open',
        v: 'The default. Any project member who mentions the bot gets a session.',
      },
      {
        k: 'owner_approval',
        v: 'A session starts only once the channel owner approves the request.',
      },
      { k: 'owner_only', v: 'Only the owner. Everyone else gets nothing, predictably.' },
    ],
  },
} as const;

export const rules = {
  eyebrow: 'Same rules',
  title: 'A chat surface is not a side door.',
  sub: 'A message in Slack gets no privileges a session in the dashboard would not get. The surface changes. Nothing underneath it does.',
  rows: [
    {
      id: 'identity',
      k: 'Every sender is a known person',
      v: 'Kortix links a chat sender to a Kortix account before the agent runs for them. Run /kortix login and sign in. An unlinked sender gets a prompt to link, not a session — so a stranger in a shared channel cannot spend your compute.',
    },
    {
      id: 'credentials',
      k: 'The bot token never enters a sandbox',
      v: 'A connected channel’s token is a connector-scoped secret. It does not appear on the project’s Secrets page, and Kortix never injects it into a cloud computer. It is resolved server-side at the moment the agent sends a message.',
    },
    {
      id: 'agent',
      k: 'It runs as an agent you chose',
      v: 'A channel names its agent and model, and inherits that agent’s deny-by-default reach into connectors, secrets and skills. Change either with one line in the thread.',
    },
    {
      id: 'cr',
      k: 'Nothing merges itself',
      v: 'The agent answers in the thread. Work it means to keep is committed on the session’s own branch and reaches main only through a change request a person reviews.',
    },
  ],
} as const;

export const custom = {
  eyebrow: 'Everything else',
  title: 'No channel for your platform? Here is the honest path.',
  sub: 'There is no build-your-own-channel API — the platform list is a closed enum and we will not dress a gap up as a plug-in system. What ships is a signed webhook trigger that starts a session per conversation. It solves the inbound half well, and we will tell you exactly what it does not do.',
  yaml: {
    title: 'kortix.yaml',
    lines: [
      '# any conversational source, without channel-specific code',
      'triggers:',
      '  - slug: support-inbox',
      '    type: webhook',
      '    agent: support',
      '    secret_env: WEBHOOK_SECRET',
      '',
      '    # one session per conversation, not one per message',
      '    session_mode: keyed',
      '    session_key: "{{ body.data.conversation_id }}"',
      '',
      '    # ignore the agent’s own outbound messages',
      '    filter:',
      '      "body.data.direction": "inbound"',
      '',
      '    prompt: "{{ body.data.text }}"',
    ],
  },
  points: [
    {
      id: 'keyed',
      title: 'What you get',
      body: 'One session per conversation. session_key renders from the payload, so a single trigger fans out into a session per chat, per customer, or per repository — separate threads rather than one blended transcript.',
    },
    {
      id: 'filter',
      title: 'And a loop breaker',
      body: 'A source that reports both sides of a conversation would otherwise fire the agent on its own reply. filter drops those deliveries with a 200 and no session. Signed with HMAC-SHA256, like every Kortix webhook.',
    },
    {
      id: 'gap',
      title: 'What you do not get',
      body: 'No reply relay. A real channel streams the answer back for you; here the agent has to send the outbound message itself, through a connector you have granted it. Inbound is solved. Outbound is your wiring.',
    },
  ],
  ctaLabel: 'See how triggers work',
  ctaHref: '/automations',
} as const;

export const closing = {
  eyebrow: 'Connect it',
  title: 'Put it in the thread people already use.',
  sub: 'Open source and self-hostable. Any model, your keys. Kortix Cloud, your own VPC, or fully on-prem.',
  ctaPrimary: 'Connect Slack',
  ctaPrimaryHref: '/auth',
  ctaSecondary: 'Read the channel docs',
  ctaSecondaryHref: '/docs/connect/slack',
} as const;
