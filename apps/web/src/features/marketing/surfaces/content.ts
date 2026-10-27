/**
 * Copy for the surface pages: /desktop, /mobile, /cli, /slack, /teams.
 *
 * Plain English here, localized through the UI catalog where a key exists
 * (same precedent as `download/content.ts`).
 *
 * ACCURACY GATE — every line traces to shipped code (checked 2026-10-26):
 *  Desktop: the app wraps the hosted web app; sessions still run on cloud
 *   machines, so never "runs Kortix on your machine". Quick Entry is
 *   apps/desktop-electron/src/quick-entry.js (5 recent sessions, 10 files of
 *   20 MB, screenshot on macOS). Screen and keyboard control ship on macOS and
 *   Windows only. macOS: one universal .dmg, 10.15+; Linux: AppImage x86_64.
 *  Mobile: both store listings are public (mobile-store-urls.ts); iOS 16.4+,
 *   iPad supported, over-the-air updates. Projects, accounts and connectors
 *   are created on the web, not the phone. No offline mode. Warm sessions and
 *   the notification inbox are beta flags: not claimed.
 *  CLI: commands from apps/cli/src/command-table.ts; install script is
 *   bash-only (macOS and Linux, x86_64 and arm64, WSL on Windows). The TUI is
 *   experimental: not claimed.
 *  Slack: channels/slack/*. Never bare "one click": the bot is invited and
 *   mentioned. Thread = session; Stop button; review and connector cards;
 *   /kortix login for per-person identity.
 *  Teams: channels/teams/*; the `teams` flag graduated 2026-10-01. Needs a
 *   tenant admin's consent once. No reactions, no message search.
 */

import { localizeUiCatalog } from '@kortix/ui/i18n';
import { REMAINING_UI_TRANSLATION_KEYS } from '@kortix/ui/i18n/ui-catalog/remaining-ui-translation-keys.generated';
import { APP_STORE_URL, GOOGLE_PLAY_URL } from '@kortix/ui/internal/lib/mobile-store-urls';
import type { UiTranslator } from '@/i18n/translator';

import type { MarkId } from './surface-mark';

export type SurfaceId = 'desktop' | 'mobile' | 'cli' | 'slack' | 'teams';

export type SurfaceAction = {
  label: string;
  href: string;
  external?: boolean;
  primary?: boolean;
  icon?: MarkId;
};

export type SurfaceSection = {
  id: string;
  title: string;
  titleMuted: string;
  body: readonly string[];
  cells: readonly { k: string; v: string }[];
  cols?: string;
};

export type SurfaceContent = {
  id: SurfaceId;
  hero: {
    title: string;
    titleMuted: string;
    sub: string;
    actions: readonly SurfaceAction[];
    note?: string;
  };
  specs: readonly { k: string; v: string }[];
  sections: readonly SurfaceSection[];
};

/** Every surface, in menu order, with the one line its cross-link cell shows. */
export const SURFACE_ORDER: readonly { id: SurfaceId; href: string; name: string; line: string }[] = [
  { id: 'desktop', href: '/desktop', name: 'Desktop', line: 'Mac, Windows and Linux, with Quick Entry.' },
  { id: 'mobile', href: '/mobile', name: 'Mobile', line: 'iPhone, iPad and Android.' },
  { id: 'cli', href: '/cli', name: 'CLI', line: 'One binary for people and agents.' },
  { id: 'slack', href: '/slack', name: 'Slack', line: 'Mention it in a thread.' },
  { id: 'teams', href: '/teams', name: 'Microsoft Teams', line: 'Chats, group chats and channels.' },
];

const DESKTOP: SurfaceContent = {
  id: 'desktop',
  hero: {
    title: 'Kortix, in its own window.',
    titleMuted: 'On Mac, Windows and Linux.',
    sub: 'The Kortix you use in the browser, as a native app: a prompt bar over any app, a badge for finished work, and an opt-in link to this computer.',
    actions: [
      { label: 'Download for macOS', href: '/download/macos', primary: true, icon: 'apple' },
      { label: 'Windows', href: '/download/windows', icon: 'windows' },
      { label: 'Linux', href: '/download/linux', icon: 'linux' },
    ],
    note: 'macOS 10.15 or later, one universal build · Windows 64-bit · Linux AppImage, x86_64',
  },
  specs: [
    { k: 'Platforms', v: 'macOS, Windows and Linux' },
    { k: 'macOS', v: 'One universal build, 10.15 or later' },
    { k: 'Linux', v: 'AppImage, x86_64' },
    { k: 'Updates', v: 'Downloaded in the background' },
  ],
  sections: [
    {
      id: 'quick-entry',
      title: 'Ask from anywhere.',
      titleMuted: 'A prompt bar over any app.',
      body: [
        '**Quick Entry** opens on top of whatever you are doing. Start a new session or send to one of your five most recent ones, pick the agent, and attach up to 10 files.',
        'On macOS one button adds a screenshot of your screen. The shortcut is **⌘⇧Space** on a Mac and **Ctrl+Shift+Space** on Windows and Linux.',
      ],
      cells: [
        { k: 'Shortcut', v: '⌘⇧Space on a Mac, Ctrl+Shift+Space elsewhere.' },
        { k: 'Where it goes', v: 'A new session, or one of your five most recent.' },
        { k: 'Attachments', v: 'Up to 10 files, 20 MB each.' },
        { k: 'Screenshot', v: 'One click on macOS adds your screen.' },
      ],
    },
    {
      id: 'this-computer',
      title: 'Lend an agent this computer.',
      titleMuted: 'Only when you say so.',
      body: [
        'Sessions run on their own cloud machine. **Connect this computer** and an agent can also use its files and shell, and on macOS and Windows its screen and keyboard.',
        'Allow it for **one hour or 24 hours**, ask each time, or turn it off. A tray icon shows the connection; pause or disconnect it there.',
      ],
      cells: [
        { k: 'Access', v: 'Files and shell; screen and keyboard on macOS and Windows.' },
        { k: 'For how long', v: 'One hour, 24 hours, ask each time, always or off.' },
        { k: 'Tray', v: 'Pause, keep awake, open at login, disconnect.' },
        { k: 'Your call', v: 'Disconnect from the tray at any time.' },
      ],
    },
    {
      id: 'native',
      title: 'A native app, not a tab.',
      titleMuted: 'It tells you when work is done.',
      body: [
        'The Dock or taskbar badge counts **sessions with a finished turn you have not read**. Connector sign-ins open inside the app; your own sign-in goes through your browser and back.',
        'Updates download in the background and ask once to restart. On first launch, choose **Kortix Cloud or your own self-hosted instance**; change it later from the menu.',
      ],
      cells: [
        { k: 'Badge', v: 'Counts sessions with a turn you have not read.' },
        { k: 'Sign-in', v: 'In your browser, then back to the app.' },
        { k: 'Self-hosted', v: 'Point the app at your own Kortix.' },
        { k: 'Updates', v: 'In the background; restart when you choose.' },
      ],
    },
  ],
};

const MOBILE: SurfaceContent = {
  id: 'mobile',
  hero: {
    title: 'Kortix in your pocket.',
    titleMuted: 'Start, steer and approve from your phone.',
    sub: 'The native app for iPhone, iPad and Android. Talk to your agents, answer their questions, and approve their work wherever you are.',
    actions: [
      { label: 'App Store', href: APP_STORE_URL, external: true, primary: true, icon: 'appstore' },
      { label: 'Google Play', href: GOOGLE_PLAY_URL, external: true, icon: 'googleplay' },
    ],
    note: 'iOS 16.4 or later · iPad supported · Android on Google Play',
  },
  specs: [
    { k: 'Platforms', v: 'iPhone, iPad and Android' },
    { k: 'Stores', v: 'App Store and Google Play' },
    { k: 'iOS', v: '16.4 or later' },
    { k: 'Input', v: 'Type, dictate or attach' },
  ],
  sections: [
    {
      id: 'sessions',
      title: 'The whole session, on a small screen.',
      titleMuted: 'Not a companion app.',
      body: [
        'Chat with any session as it streams. Pick **the model and the agent**, @-mention files and skills, and dictate instead of typing.',
        'Attach from **the camera, your photos or Files**, or paste text. Project files, sandbox previews and session sharing come with you.',
      ],
      cells: [
        { k: 'Live', v: 'Watch a turn arrive, step by step.' },
        { k: 'Dictation', v: 'Speak; the phone’s own recognizer types.' },
        { k: 'Attachments', v: 'Camera, photos, Files or pasted text.' },
        { k: 'Previews', v: 'Open what the agent built.' },
      ],
    },
    {
      id: 'approvals',
      title: 'Approve from anywhere.',
      titleMuted: 'Your agents wait for you, not your laptop.',
      body: [
        'When an agent needs permission, a card sits above the composer: **Deny, Allow once or Allow always**. Its questions arrive as answers you tap.',
        'The review inbox shows each **change request with its diff**. Approve or reject it from the phone.',
      ],
      cells: [
        { k: 'Permissions', v: 'Deny, allow once or allow always.' },
        { k: 'Questions', v: 'Answer the agent in a tap.' },
        { k: 'Change requests', v: 'Read the diff, then approve or reject.' },
        { k: 'Schedules', v: 'Create, pause and run triggers.' },
      ],
    },
    {
      id: 'notifications',
      title: 'It tells you when to look.',
      titleMuted: 'A push, not a refresh.',
      body: [
        'A push arrives when a turn **finishes, fails, asks a question or needs permission**. Choose which ones in Settings.',
        'Sign in with Google, Apple or email, with two-factor. Point the app at **your own self-hosted Kortix** if you run one.',
      ],
      cells: [
        { k: 'Push', v: 'Finished, failed, a question, a permission.' },
        { k: 'Sign-in', v: 'Google, Apple on iOS, or email, with 2FA.' },
        { k: 'Self-hosted', v: 'Use your own Kortix instance.' },
        { k: 'Updates', v: 'Fixes arrive over the air.' },
      ],
    },
  ],
};

const CLI: SurfaceContent = {
  id: 'cli',
  hero: {
    title: 'Your company, from the terminal.',
    titleMuted: 'One binary for you and your agents.',
    sub: 'kortix creates, ships and runs projects, sessions and the account from a shell or a script. The same commands work for a person and for an agent.',
    actions: [
      { label: 'Read the CLI docs', href: '/docs/cli', primary: true, icon: 'cli' },
      { label: 'Self-host with it', href: '/self-hosted' },
    ],
    note: 'curl -fsSL https://kortix.com/install | bash',
  },
  specs: [
    { k: 'Install', v: 'One curl line' },
    { k: 'Systems', v: 'macOS and Linux, WSL on Windows' },
    { k: 'Architectures', v: 'x86_64 and arm64' },
    { k: 'Self-host', v: 'kortix self-host start' },
  ],
  sections: [
    {
      id: 'lifecycle',
      title: 'From an empty folder to a running company.',
      titleMuted: 'init, ship, chat.',
      body: [
        '**kortix init** scaffolds a project, **kortix ship** creates it in the cloud and pushes it, and **kortix chat** opens a session: a REPL, or one prompt and out with --prompt.',
        'Agents, connectors, secrets, triggers, files and change requests each have a command, so **what you do in the app, you can script**.',
      ],
      cols: 'lg:grid-cols-3',
      cells: [
        { k: 'init', v: 'Scaffold a project with its kortix.yaml.' },
        { k: 'ship', v: 'Create the cloud project and push.' },
        { k: 'chat', v: 'A REPL, or one prompt and out.' },
        { k: 'sessions', v: 'List and follow sessions.' },
        { k: 'cr', v: 'Work with change requests.' },
        { k: 'triggers', v: 'Cron and webhook triggers.' },
      ],
    },
    {
      id: 'admin',
      title: 'Run the account from a script.',
      titleMuted: 'People, access and the audit log.',
      body: [
        '**members, groups, roles and permissions** decide who can do what. **audit** reads the log; **tokens** issues personal access tokens for scripts.',
        '**doctor** checks a project, **validate** checks its kortix.yaml, and **migrate** moves it to the current schema.',
      ],
      cells: [
        { k: 'Access', v: 'members, groups, roles, permissions.' },
        { k: 'Audit', v: 'Read the audit log.' },
        { k: 'Checks', v: 'doctor, validate, migrate.' },
        { k: 'Tokens', v: 'Personal access tokens for scripts.' },
      ],
    },
    {
      id: 'self-host',
      title: 'Run all of Kortix yourself.',
      titleMuted: 'The same CLI, your own box.',
      body: [
        '**kortix self-host start** runs Kortix from the same Docker images the cloud runs. **update, stop, status and logs** manage it.',
        '**kortix hosts** switches the CLI between the cloud and your own instance, so one binary talks to both.',
      ],
      cells: [
        { k: 'start', v: 'Bring up the whole stack.' },
        { k: 'update', v: 'Move to the latest images.' },
        { k: 'logs', v: 'Follow what the stack is doing.' },
        { k: 'hosts', v: 'Switch between cloud and your box.' },
      ],
    },
  ],
};

const SLACK: SurfaceContent = {
  id: 'slack',
  hero: {
    title: 'Kortix in Slack.',
    titleMuted: 'Mention it in a thread. Get the work back there.',
    sub: 'Each thread is a session. An agent runs it on its own machine, streams its progress into the thread, and asks before it acts, as the person who asked.',
    actions: [
      { label: 'Connect Slack', href: '/auth', primary: true, icon: 'slack' },
      { label: 'Setup guide', href: '/docs/connect/channels' },
    ],
    note: 'Add the app, invite it to a channel, mention it with a task.',
  },
  specs: [
    { k: 'Thread', v: 'One thread, one session' },
    { k: 'Approvals', v: 'Cards in the thread' },
    { k: 'Identity', v: 'Each person signs in once' },
    { k: 'Install', v: 'OAuth, or your own Slack app' },
  ],
  sections: [
    {
      id: 'threads',
      title: 'One thread, one session.',
      titleMuted: 'Follow-ups keep the context.',
      body: [
        'Mention Kortix in a channel or message it directly. The thread becomes a session: the agent works on its own machine and **streams its progress into the thread**, with a Stop button.',
        'Reply in the thread to steer it. In a DM every message reaches the agent; in a channel, only a mention does.',
      ],
      cells: [
        { k: 'Start', v: 'Mention @Kortix, or send a DM.' },
        { k: 'Progress', v: 'Live steps in the thread, with Stop.' },
        { k: 'Follow-up', v: 'A reply continues the same session.' },
        { k: 'App Home', v: 'The Assistant pane and a Home tab.' },
      ],
    },
    {
      id: 'approvals',
      title: 'Approve without leaving Slack.',
      titleMuted: 'Nothing ships until a person taps.',
      body: [
        'When an agent opens a change request or needs a connector, a card lands in the thread: **Ship it or Reject, Approve or Deny**, or ask for changes.',
        'When the agent has a question, the answers arrive as buttons.',
      ],
      cells: [
        { k: 'Change requests', v: 'Ship it, reject, or ask for changes.' },
        { k: 'Connector calls', v: 'Approve or deny the call.' },
        { k: 'Questions', v: 'Answer with a button.' },
        { k: 'Stop', v: 'End a run from the thread.' },
      ],
    },
    {
      id: 'identity',
      title: 'It runs as you.',
      titleMuted: 'Your permissions, not a shared bot’s.',
      body: [
        'Each person runs **/kortix login** once. From then on a run uses the sender’s own Kortix permissions, and personal keys stay in DMs.',
        'Set the project, agent, model and who may join **per channel** with /kortix. One workspace can serve several projects.',
      ],
      cells: [
        { k: 'Identity', v: 'Each person links their account once.' },
        { k: 'Per channel', v: 'Project, agent, model and join policy.' },
        { k: 'Several projects', v: 'A project picker per channel.' },
        { k: 'Your own app', v: 'Bring your own Slack app instead.' },
      ],
    },
  ],
};

const TEAMS: SurfaceContent = {
  id: 'teams',
  hero: {
    title: 'Kortix in Microsoft Teams.',
    titleMuted: 'In chats, group chats and channels.',
    sub: 'The same agent sessions inside Teams: progress in one live card, an approval card before every action, and each run as the person who asked.',
    actions: [
      { label: 'Connect Teams', href: '/auth', primary: true, icon: 'teams' },
      { label: 'Setup guide', href: '/docs/connect/channels' },
    ],
    note: 'A Teams admin grants consent once; then anyone in the organization adds it.',
  },
  specs: [
    { k: 'Works in', v: 'Chats, group chats and channels' },
    { k: 'Setup', v: 'Admin consent, then the org catalog' },
    { k: 'Files', v: 'OneDrive and SharePoint' },
    { k: 'Identity', v: 'Each person signs in once' },
  ],
  sections: [
    {
      id: 'where',
      title: 'Where your team already talks.',
      titleMuted: 'Three places, three behaviours.',
      body: [
        'In a **personal chat** every message reaches the agent, one session until /new. In a **group chat** a mention starts it and replies continue it. In a **channel** each post is its own session.',
        'One live card shows the steps, then the reply. Type /stop to end a run.',
      ],
      cells: [
        { k: 'Personal chat', v: 'Every message; one session until /new.' },
        { k: 'Group chat', v: 'A mention starts it; replies continue.' },
        { k: 'Channel', v: 'Each post is its own session.' },
        { k: 'Live card', v: 'The steps, then the reply.' },
      ],
    },
    {
      id: 'approvals',
      title: 'Approve in the card.',
      titleMuted: 'With a note, if you want one.',
      body: [
        'Change requests and connector calls arrive as **approval cards**, with an optional feedback box. Questions come as buttons, forms, or date and number inputs.',
        'Some replies are **visible only to the person who asked**. Any message opens in Kortix from its ⋯ menu.',
      ],
      cells: [
        { k: 'Approvals', v: 'Approve or deny, with feedback.' },
        { k: 'Questions', v: 'Buttons, forms, dates and numbers.' },
        { k: 'Private replies', v: 'Only the asker sees them.' },
        { k: 'Open in Kortix', v: 'From any message’s ⋯ menu.' },
      ],
    },
    {
      id: 'setup',
      title: 'One consent, then everyone.',
      titleMuted: 'Or bring your own bot.',
      body: [
        'A tenant admin **grants consent once**, and Kortix publishes the app to your organization’s catalog. From then on, anyone adds it to Teams.',
        'Each person signs in once with /login, so a run uses their own permissions. Images show inline; other files go to **OneDrive** in personal chats and **SharePoint** in channels.',
      ],
      cells: [
        { k: 'Consent', v: 'A tenant admin approves once.' },
        { k: 'Catalog', v: 'Published to your organization’s apps.' },
        { k: 'Your own bot', v: 'Use your own Azure Bot instead.' },
        { k: 'Files', v: 'OneDrive in chats, SharePoint in channels.' },
      ],
    },
  ],
};

const SURFACES: Record<SurfaceId, SurfaceContent> = {
  desktop: DESKTOP,
  mobile: MOBILE,
  cli: CLI,
  slack: SLACK,
  teams: TEAMS,
};

export function getLocalizedSurface(id: SurfaceId, tI18nComplete: UiTranslator): SurfaceContent {
  return localizeUiCatalog(SURFACES[id], tI18nComplete, REMAINING_UI_TRANSLATION_KEYS);
}
