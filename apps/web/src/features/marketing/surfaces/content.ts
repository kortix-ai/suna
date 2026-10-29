/**
 * Copy for the five "Use it from" pages: /desktop, /mobile, /cli, /slack,
 * /teams. One shape per page, in the home page's rhythm: hero (with one
 * product visual), pillars, one tab per capability, FAQ. The visuals live in
 * `stages.tsx` (hero) and `panels.tsx` (tabs). English only, like /security.
 *
 * Every line was checked on 2026-10-28. Sources, by page:
 *  Desktop: apps/desktop-electron (quick-entry.js, quick-entry-rules.js:
 *   5 recent sessions, 10 files of 20 MB, the three shortcuts; app-menu.js
 *   "Quick Entry Shortcut"; computer.js accessPrompt; attention-badge.js;
 *   instance-chooser.js; electron-builder.yml: universal dmg, 10.15+, nsis,
 *   AppImage; Computer Use ships cua-driver on mac and win only);
 *   guide.mdx "Desktop app", "Connect your own computer".
 *   Sessions run on cloud computers: never "runs Kortix on your machine".
 *  Mobile: apps/mobile (PermissionPromptCard: Deny / Allow once / Allow
 *   always; ReviewDetailSheet: Merge / Request changes; (settings)/
 *   notifications.tsx: the four kinds; (settings)/instances.tsx; app.json
 *   supportsTablet; ios/Podfile 16.4); mobile-store-urls.ts (both listings
 *   public); guide.mdx "The mobile app".
 *  CLI: `kortix --help` and `<cmd> --help` (chat, cr, review, init, ship,
 *   members, access, audit, self-host, hosts); download/cli route targets
 *   darwin/linux x arm64/x64; guide.mdx "The terminal" (TUI experimental).
 *  Slack: apps/api/src/channels/slack (review-cards.ts, approval-card.ts,
 *   turn.ts Stop, identity.ts, commands.ts); guide.mdx "Channels". Never
 *   bare "one click". The agent acts with its own permissions, not the
 *   sender's role (guide.mdx; channels/core/identity.ts).
 *  Teams: apps/api/src/channels/teams (cards.ts buildReviewCard with the
 *   feedback box, commands.ts /new /stop /login, file-proxy.ts OneDrive and
 *   SharePoint, message-action.ts "Open in Kortix", private-reply.ts);
 *   claims.md "Channels" (Teams live). No reactions, no message search.
 * Sample data: the fictional Arcadia; people are "Member N".
 */

import type { ComponentType } from 'react';
import {
  ArrowsClockwiseIcon,
  BellRingingIcon,
  BracketsCurlyIcon,
  ChatsCircleIcon,
  CheckSquareOffsetIcon,
  DesktopIcon,
  FilesIcon,
  HardDrivesIcon,
  IdentificationBadgeIcon,
  KeyboardIcon,
  LightningIcon,
  PaperPlaneTiltIcon,
  PlayCircleIcon,
  RobotIcon,
  TerminalWindowIcon,
  UsersThreeIcon,
} from '@phosphor-icons/react/dist/ssr';
import { APP_STORE_URL, GOOGLE_PLAY_URL } from '@kortix/ui/internal/lib/mobile-store-urls';

import type { MarkId } from './surface-mark';

export type SurfaceId = 'desktop' | 'mobile' | 'cli' | 'slack' | 'teams';

export type SurfaceAction = {
  label: string;
  href: string;
  external?: boolean;
  primary?: boolean;
  icon?: MarkId;
};

export type Pillar = { icon: ComponentType<{ className?: string }>; name: string; line: string; body: string };

export type HowTab = { id: string; title: string; description: string; body: readonly string[] };

export type SurfaceContent = {
  id: SurfaceId;
  hero: {
    title: string;
    titleMuted: string;
    sub: string;
    /** `install` puts the CLI install command first. */
    install?: boolean;
    actions: readonly SurfaceAction[];
    note: string;
    caption: string;
    captionMuted: string;
  };
  pillars: { title: string; titleMuted: string; items: readonly Pillar[] };
  how: { title: string; titleMuted: string; tabs: readonly HowTab[] };
  faq: readonly { id: string; question: string; answer: string }[];
};

/** Every surface, in menu order, with the one line its cross-link cell shows. */
export const SURFACE_ORDER: readonly { id: SurfaceId; href: string; name: string; line: string }[] = [
  { id: 'desktop', href: '/desktop', name: 'Desktop', line: 'macOS, Windows and Linux, with Quick Entry.' },
  { id: 'mobile', href: '/mobile', name: 'Mobile', line: 'iPhone, iPad and Android.' },
  { id: 'cli', href: '/cli', name: 'CLI', line: 'One binary for people, scripts and agents.' },
  { id: 'slack', href: '/slack', name: 'Slack', line: 'Mention it in a thread.' },
  { id: 'teams', href: '/teams', name: 'Microsoft Teams', line: 'Chats, group chats and channels.' },
];

const DESKTOP: SurfaceContent = {
  id: 'desktop',
  hero: {
    title: 'Kortix on your desktop.',
    titleMuted: 'For macOS, Windows and Linux.',
    sub: 'The Kortix app in its own window. Hand an agent a task from any app with one shortcut, and see at a glance when its work is done.',
    actions: [
      { label: 'Download for macOS', href: '/download/macos', primary: true, icon: 'apple' },
      { label: 'Windows', href: '/download/windows', icon: 'windows' },
      { label: 'Linux', href: '/download/linux', icon: 'linux' },
    ],
    note: 'macOS 10.15 or later, one universal build · Windows 64-bit · Linux AppImage, x86_64',
    caption: '⌘⇧Space opens Quick Entry over any app.',
    captionMuted: 'The agent still works on its own cloud computer.',
  },
  pillars: {
    title: 'A native app, not a browser tab.',
    titleMuted: 'Four things the desktop adds.',
    items: [
      {
        icon: KeyboardIcon,
        name: 'Quick Entry',
        line: 'A prompt bar over any app.',
        body: '⌘⇧Space on a Mac, Ctrl+Shift+Space on Windows and Linux. Type the task, press Enter.',
      },
      {
        icon: BellRingingIcon,
        name: 'A badge for finished work',
        line: 'On the Dock or the taskbar.',
        body: 'It counts the sessions with a finished turn you have not read.',
      },
      {
        icon: DesktopIcon,
        name: 'This computer, if you allow it',
        line: 'Files, shell and screen.',
        body: 'Connect it, and an agent can work on your own machine, for as long as you allow.',
      },
      {
        icon: ArrowsClockwiseIcon,
        name: 'Always current',
        line: 'It updates itself.',
        body: 'When an update is ready, choose Restart now or Later.',
      },
    ],
  },
  how: {
    title: 'How the desktop app works.',
    titleMuted: 'One shortcut, one computer, one badge.',
    tabs: [
      {
        id: 'quick-entry',
        title: 'Hand off a task from any app',
        description: 'Quick Entry: one shortcut, one prompt.',
        body: [
          'Press ⌘⇧Space in any app. Type the task and press Enter: Kortix starts a new session in the project you have open.',
          'The picker sends it to one of your 5 most recent sessions instead. Attach up to 10 files of 20 MB each, or a screenshot on macOS.',
        ],
      },
      {
        id: 'connect',
        title: 'Lend an agent this computer',
        description: 'Filesystem, Shell, Computer Use.',
        body: [
          'Select Connect this computer in the sidebar, check the code in your browser, and choose what agents may use.',
          'Computer Use runs on macOS and Windows. The computer is private to you until you share it with a project.',
        ],
      },
      {
        id: 'access',
        title: 'Approve each use on the machine',
        description: 'Ask each time, always, or off.',
        body: [
          'The computer decides, whatever the project allows. In Ask each time, the first call opens a prompt on your screen.',
          'Only you, at the computer, can widen access. Revoke it from the menu bar or the tray at any time.',
        ],
      },
      {
        id: 'badge',
        title: 'See when work is done',
        description: 'A count on the Dock or the taskbar.',
        body: [
          'The badge counts the sessions with a finished turn you have not read. Windows shows a dot on the taskbar icon.',
          'With a connected computer, the app stays in the menu bar or the tray when you close the last window.',
        ],
      },
    ],
  },
  faq: [
    {
      id: 'desktop-where-agents-run',
      question: 'Do agents run on my computer?',
      answer:
        'No. Every session runs on its own cloud computer. The desktop app is the Kortix web app in a native window. An agent uses your computer only after you connect it, and only for what you allowed.',
    },
    {
      id: 'desktop-systems',
      question: 'Which systems does it run on?',
      answer:
        'macOS 10.15 or later, as one universal build for Apple silicon and Intel. Windows 64-bit. Linux as an AppImage for x86_64; there is no arm64 build.',
    },
    {
      id: 'desktop-shortcut',
      question: 'Can I change the Quick Entry shortcut?',
      answer:
        'Yes. The Quick Entry Shortcut menu offers ⌘⇧Space, ⌥Space and ⌥⇧Space on a Mac, and the same keys with Ctrl and Alt on Windows and Linux.',
    },
    {
      id: 'desktop-self-hosted',
      question: 'Does it work with a self-hosted Kortix?',
      answer:
        'Yes. On first launch, choose Kortix Cloud or your own instance. Change it later with Change Kortix Instance… in the menu.',
    },
  ],
};

const MOBILE: SurfaceContent = {
  id: 'mobile',
  hero: {
    title: 'Kortix on your phone.',
    titleMuted: 'Start, follow and approve work from anywhere.',
    sub: 'The native app for iPhone, iPad and Android. Start a session, watch it work, and answer an agent the moment it asks.',
    actions: [
      { label: 'App Store', href: APP_STORE_URL, external: true, primary: true, icon: 'appstore' },
      { label: 'Google Play', href: GOOGLE_PLAY_URL, external: true, icon: 'googleplay' },
    ],
    note: 'iOS 16.4 or later · iPad supported · Android on Google Play',
    caption: 'Approve a step from your pocket.',
    captionMuted: 'The agent waits until you decide.',
  },
  pillars: {
    title: 'Your agents, wherever you are.',
    titleMuted: 'Not a companion app. The sessions themselves.',
    items: [
      {
        icon: PaperPlaneTiltIcon,
        name: 'Start anywhere',
        line: 'Type, dictate or attach.',
        body: 'Open a project and start a session, with a photo, a file or your voice.',
      },
      {
        icon: PlayCircleIcon,
        name: 'Follow it live',
        line: 'Every step as it happens.',
        body: 'Open a running session and watch the turn arrive.',
      },
      {
        icon: CheckSquareOffsetIcon,
        name: 'Approve on the spot',
        line: 'Permissions and change requests.',
        body: 'Allow a step, or read a change request’s diff and merge it.',
      },
      {
        icon: BellRingingIcon,
        name: 'A push when it matters',
        line: 'Not a refresh.',
        body: 'When a session finishes, fails, asks a question or needs a permission.',
      },
    ],
  },
  how: {
    title: 'How the mobile app works.',
    titleMuted: 'Four things you do from the phone.',
    tabs: [
      {
        id: 'start',
        title: 'Start a session',
        description: 'Type, dictate or attach.',
        body: [
          'Open a project and type a task, or dictate it. Pick the agent and the model for the turn.',
          'Attach a photo, a file or a picture from the camera. The agent works with it on its own cloud computer.',
        ],
      },
      {
        id: 'permission',
        title: 'Answer a permission',
        description: 'Deny, Allow once, Allow always.',
        body: [
          'When an agent’s rules say ask, the turn stops and a card sits above the composer. It shows the tool and what it will run.',
          'Choose Deny, Allow once or Allow always. The turn continues as soon as you decide.',
        ],
      },
      {
        id: 'review',
        title: 'Review a change request',
        description: 'Read the diff, then decide.',
        body: [
          'Agents send their changes as change requests. Open one to read its diff, file by file.',
          'Merge it, or request changes with a note for the agent.',
        ],
      },
      {
        id: 'notify',
        title: 'Choose your notifications',
        description: 'Four kinds, each a switch.',
        body: [
          'Your phone gets a push when a session finishes, fails, asks a question or needs a permission.',
          'Turn each kind on or off in Settings, under Notifications.',
        ],
      },
    ],
  },
  faq: [
    {
      id: 'mobile-devices',
      question: 'Which devices does it run on?',
      answer: 'iPhone and iPad with iOS 16.4 or later, and Android phones from Google Play.',
    },
    {
      id: 'mobile-same-sessions',
      question: 'Are these the same sessions as on the web?',
      answer:
        'Yes. The web app, the desktop app and the phone read the same projects and sessions. Start on one and continue on another.',
    },
    {
      id: 'mobile-invites',
      question: 'Can I accept an invite on my phone?',
      answer: 'Yes. Accept or decline an invite to a project in the app, then browse the project’s files.',
    },
    {
      id: 'mobile-self-hosted',
      question: 'Does it work with a self-hosted Kortix?',
      answer: 'Yes. Add your own instance in Settings, then sign in to it.',
    },
  ],
};

const CLI: SurfaceContent = {
  id: 'cli',
  hero: {
    title: 'Kortix from your terminal.',
    titleMuted: 'One binary for you, your scripts and your agents.',
    sub: 'The kortix command does from a shell what the web app does. It creates projects, runs sessions, reviews change requests, and configures agents, connectors and secrets.',
    install: true,
    actions: [{ label: 'Read the CLI docs', href: '/docs/developers#cli' }],
    note: 'macOS and Linux, x86_64 and arm64 · On Windows, use WSL',
    caption: 'From a prompt to a merged change, in four commands.',
    captionMuted: 'Every command also runs inside an agent’s session.',
  },
  pillars: {
    title: 'The same commands for everyone.',
    titleMuted: 'People, scripts and agents.',
    items: [
      {
        icon: TerminalWindowIcon,
        name: 'For you',
        line: 'A REPL, or one prompt and out.',
        body: '`kortix chat` talks to a session’s agent. `--prompt` sends one message and prints the reply.',
      },
      {
        icon: BracketsCurlyIcon,
        name: 'For scripts',
        line: 'JSON and exit codes.',
        body: 'Read commands take `--json`. A failed run or a blocked merge exits non-zero.',
      },
      {
        icon: RobotIcon,
        name: 'For agents',
        line: 'No login inside a session.',
        body: 'In a session’s sandbox, `kortix` reads its token and project from the environment.',
      },
      {
        icon: HardDrivesIcon,
        name: 'For your own servers',
        line: 'Self-host with one command.',
        body: '`kortix self-host start` pulls the images and starts the stack.',
      },
    ],
  },
  how: {
    title: 'How the CLI works.',
    titleMuted: 'Five jobs, each a command.',
    tabs: [
      {
        id: 'start',
        title: 'Start a project',
        description: 'init, then ship.',
        body: [
          '`kortix init` creates a project folder with its `kortix.yaml`. `kortix ship` validates it, commits, and on the first run creates the cloud project.',
          'Run `ship` again any time. It commits and pushes the branch you are on.',
        ],
      },
      {
        id: 'run',
        title: 'Run a session',
        description: 'chat, steer, queue.',
        body: [
          '`kortix chat --new` starts a session. `-p` sends one prompt and prints the reply; without it, you get a REPL.',
          '`--steer` hands a message to the turn that is running. `--queue` stores it, even while the sandbox sleeps.',
        ],
      },
      {
        id: 'review',
        title: 'Review the work',
        description: 'cr and review.',
        body: [
          'Agents send their work as change requests. `kortix cr diff` shows one, and `kortix cr merge` merges it.',
          '`kortix review ls` lists everything that waits on a person: change requests, connector calls and outputs.',
        ],
      },
      {
        id: 'admin',
        title: 'Run the account',
        description: 'members, access, audit.',
        body: [
          '`members` invites people and sets their role. `access` grants roles to people, groups and agents.',
          '`audit` lists the account’s audit events, newest first, and exports them as CSV or JSONL.',
        ],
      },
      {
        id: 'self-host',
        title: 'Run Kortix yourself',
        description: 'self-host and hosts.',
        body: [
          '`kortix self-host start` pulls the Docker images and starts the stack. `status`, `logs` and `update` manage it.',
          '`kortix hosts use` switches the CLI between Kortix Cloud and your own instance.',
        ],
      },
    ],
  },
  faq: [
    {
      id: 'cli-systems',
      question: 'Which systems does it run on?',
      answer: 'macOS and Linux, on x86_64 and arm64. There is no Windows binary: on Windows, run it in WSL.',
    },
    {
      id: 'cli-sign-in',
      question: 'How do I sign in?',
      answer:
        'Run kortix login. Your browser opens, and you approve the sign-in there. For CI, sign in with a token: kortix hosts login --token <pat>.',
    },
    {
      id: 'cli-agents',
      question: 'Can an agent use it?',
      answer:
        'Yes. Inside a session’s sandbox, the CLI reads KORTIX_TOKEN and KORTIX_PROJECT_ID from the environment. It needs no login and no link.',
    },
    {
      id: 'cli-tui',
      question: 'Is there a terminal UI?',
      answer:
        'kortix tui opens the whole product in your terminal. It is experimental, so its screens and keys can change between releases.',
    },
  ],
};

const SLACK: SurfaceContent = {
  id: 'slack',
  hero: {
    title: 'Kortix in Slack.',
    titleMuted: 'Mention it in a thread. The work comes back there.',
    sub: 'Each Slack thread is a session. An agent works on its own cloud computer, posts its progress in the thread, and sends its changes back as a card to approve.',
    actions: [
      { label: 'Connect Slack', href: '/auth', primary: true, icon: 'slack' },
      { label: 'Read the setup guide', href: '/docs/guide#channels' },
    ],
    note: 'Add Kortix to Slack, invite the bot, mention it with a task.',
    caption: 'One thread, one session.',
    captionMuted: 'Reply in the thread to steer it.',
  },
  pillars: {
    title: 'Agents in the threads you already use.',
    titleMuted: 'Your team asks; the work comes back reviewed.',
    items: [
      {
        icon: ChatsCircleIcon,
        name: 'One thread, one session',
        line: 'Follow-ups keep the context.',
        body: 'The first message starts the session. Later messages in the thread continue it.',
      },
      {
        icon: LightningIcon,
        name: 'Live progress',
        line: 'With a Stop button.',
        body: 'The agent’s steps show in the thread while it works.',
      },
      {
        icon: CheckSquareOffsetIcon,
        name: 'Approve in the thread',
        line: 'Ship it, Reject, Ask for changes.',
        body: 'Change requests and connector approvals arrive as cards.',
      },
      {
        icon: IdentificationBadgeIcon,
        name: 'Each person signs in once',
        line: 'With `/kortix login`.',
        body: 'Kortix checks that the sender may start sessions in the project.',
      },
    ],
  },
  how: {
    title: 'How Kortix works in Slack.',
    titleMuted: 'From a mention to an approved change.',
    tabs: [
      {
        id: 'mention',
        title: 'Mention it with a task',
        description: 'In a channel, or in a DM.',
        body: [
          'Invite the bot to a channel and mention it. In a channel, only a mention reaches the agent; replies without one stay between people.',
          'In a direct message with the bot, every message reaches the agent, and the session is private to you.',
        ],
      },
      {
        id: 'progress',
        title: 'Watch it work',
        description: 'Live steps, with Stop.',
        body: [
          'The agent works on its own cloud computer and updates one message in the thread with its steps.',
          'Stop ends the run. The reply links to the full session in Kortix.',
        ],
      },
      {
        id: 'approve',
        title: 'Approve in the thread',
        description: 'Cards with buttons.',
        body: [
          'A change request arrives as a card: Ship it, Reject or Ask for changes. A connector call that needs approval shows what it will do.',
          'A project manager, or the person who started the session, decides.',
        ],
      },
      {
        id: 'login',
        title: 'Link your account once',
        description: 'With `/kortix login`.',
        body: [
          'Send `/kortix login` and open the link. Only you see it, it works once, and it expires after 10 minutes.',
          'Kortix then checks that each sender is a project member who may start sessions. The agent acts with its own permissions, not the sender’s role.',
        ],
      },
      {
        id: 'channel',
        title: 'Set it per channel',
        description: 'Project, agent, model, who may join.',
        body: [
          '`/kortix` shows the channel’s project, agent and model. One workspace can serve several projects.',
          'A join policy decides who may join a session that started in the channel.',
        ],
      },
    ],
  },
  faq: [
    {
      id: 'slack-reads',
      question: 'Does Kortix read every message in a channel?',
      answer:
        'No. In a channel, only a mention reaches the agent, and only in channels the bot was invited to. In a direct message with the bot, every message does.',
    },
    {
      id: 'slack-permissions',
      question: 'Does the agent act with my permissions?',
      answer:
        'No. Kortix checks that you are a project member who may start sessions. The agent then acts with its own permissions, not with your role.',
    },
    {
      id: 'slack-projects',
      question: 'Can one workspace serve several projects?',
      answer:
        'Yes. The first message in a new channel shows a project picker. The choice binds the channel to that project.',
    },
    {
      id: 'slack-own-app',
      question: 'Can we use our own Slack app, or a self-hosted Kortix?',
      answer:
        'Yes. kortix channels manifest prints the app manifest. Create the app from it at api.slack.com/apps, then connect it with its tokens.',
    },
  ],
};

const TEAMS: SurfaceContent = {
  id: 'teams',
  hero: {
    title: 'Kortix in Microsoft Teams.',
    titleMuted: 'In chats, group chats and channels.',
    sub: 'Mention Kortix with a task. An agent works on its own cloud computer, shows its steps in one live card, and sends its changes back as a card to approve.',
    actions: [
      { label: 'Connect Teams', href: '/auth', primary: true, icon: 'teams' },
      { label: 'Read the setup guide', href: '/docs/guide#channels' },
    ],
    note: 'A tenant admin grants consent once. Then anyone in your organization can add the app.',
    caption: 'One channel post, one session.',
    captionMuted: 'A personal chat keeps one session until /new.',
  },
  pillars: {
    title: 'Agents where your organization already talks.',
    titleMuted: 'Four things Kortix does in Teams.',
    items: [
      {
        icon: UsersThreeIcon,
        name: 'Chats and channels',
        line: 'Personal, group, team.',
        body: 'Add the app to a chat or a team, and mention it with a task.',
      },
      {
        icon: LightningIcon,
        name: 'One live card',
        line: 'The steps, then the reply.',
        body: 'Type `/stop` to end a run.',
      },
      {
        icon: CheckSquareOffsetIcon,
        name: 'Approve with a note',
        line: 'Feedback goes to the agent.',
        body: 'Every review card has an optional feedback box.',
      },
      {
        icon: FilesIcon,
        name: 'Files where Teams keeps them',
        line: 'OneDrive and SharePoint.',
        body: 'Images show inline. Other files go to OneDrive or SharePoint.',
      },
    ],
  },
  how: {
    title: 'How Kortix works in Teams.',
    titleMuted: 'From one consent to an approved change.',
    tabs: [
      {
        id: 'where',
        title: 'Three places, three behaviours',
        description: 'Personal chat, group chat, channel.',
        body: [
          'In a personal chat, every message reaches the agent. In a group chat or a channel, mention it.',
          'Each channel post is its own session. A personal or group chat keeps one session until someone sends `/new`.',
        ],
      },
      {
        id: 'card',
        title: 'Watch it work',
        description: 'One live card.',
        body: [
          'The agent works on its own cloud computer and updates one card with its steps, then posts the reply.',
          'Type `/stop` to end the run. Open in Kortix, in a message’s ⋯ menu, opens its session.',
        ],
      },
      {
        id: 'approve',
        title: 'Approve with feedback',
        description: 'Ship it, Request changes, Reject.',
        body: [
          'A change request arrives as a card with an optional feedback box. What you write goes to the agent with your decision.',
          'A connector call that needs approval shows Approve and Deny.',
        ],
      },
      {
        id: 'files',
        title: 'Files go where Teams keeps them',
        description: 'OneDrive in a chat, SharePoint in a channel.',
        body: [
          'Images show inline. In a personal chat, other files arrive in your OneDrive after you accept them.',
          'In a channel, files go to the team’s SharePoint files.',
        ],
      },
      {
        id: 'setup',
        title: 'One consent, then everyone',
        description: 'An admin once, then each person once.',
        body: [
          'A tenant admin grants consent once, and Kortix publishes the app to your organization’s Teams catalog.',
          'Each person sends `/login` once, so Kortix knows who asked.',
        ],
      },
    ],
  },
  faq: [
    {
      id: 'teams-admin',
      question: 'Do we need a Teams admin?',
      answer:
        'Yes, once. A tenant admin grants consent, and Kortix publishes the app to your organization’s catalog. After that, anyone can add it.',
    },
    {
      id: 'teams-permissions',
      question: 'Does the agent act with my permissions?',
      answer:
        'No. Kortix checks that you are a project member who may start sessions. The agent then acts with its own permissions, not with your role.',
    },
    {
      id: 'teams-own-bot',
      question: 'Can we use our own bot?',
      answer: 'Yes. Bring your own Azure Bot with its app ID and secret, then upload the app manifest.',
    },
    {
      id: 'teams-gaps',
      question: 'Does it support reactions or message search?',
      answer: 'No. Long replies are cut in Teams and link to the full session in Kortix.',
    },
  ],
};

export const SURFACES: Record<SurfaceId, SurfaceContent> = {
  desktop: DESKTOP,
  mobile: MOBILE,
  cli: CLI,
  slack: SLACK,
  teams: TEAMS,
};
