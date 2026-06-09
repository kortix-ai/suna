'use client';

import { SCENARIOS } from '../chat/scenarios';
import type { ActiveModel, PageId, ProjectCard, ProjectStatus } from '../types';
import { meta, ok, t, type Line, type Span } from './terminal';

/* ───────────────────────────────────────────────────────────────────────────
 * The CLI movie. A flat list of commands; each command is a list of `Beat`s the
 * director walks in order. Beats interleave terminal output (`out`) with the
 * web effects that keep the app in lockstep — `nav` switches tabs, `fx` mutates
 * synced state (projects ship, connectors connect, model switches, sessions run
 * chats, triggers/secrets/members get added, Slack connects).
 * Output text mirrors the real `kortix` CLI so the terminal reads as authentic.
 * ─────────────────────────────────────────────────────────────────────────── */

/** The effect surface a `fx` beat can call to drive the web app. */
export interface DirectorApi {
  nav: (page: PageId) => void;
  addProject: (project: ProjectCard) => void;
  patchProject: (name: string, patch: Partial<ProjectCard>) => void;
  setProjectStatus: (name: string, status: ProjectStatus) => void;
  connectConnector: (name: string) => void;
  connectProvider: (domain: string) => void;
  setModel: (model: ActiveModel) => void;
  addSchedule: () => void;
  addSecret: () => void;
  inviteMember: () => void;
  connectSlack: (workspace: string) => void;
  runChat: (prompt: string) => void;
}

export type Beat =
  | { kind: 'out'; line: Line }
  | { kind: 'nav'; page: PageId }
  | { kind: 'fx'; run: (api: DirectorApi) => void }
  | { kind: 'wait'; ms: number };

export type Command = {
  /** Typed at the prompt. A `note` renders as a dim `#` comment, not a `$` run. */
  input: string;
  note?: boolean;
  beats: Beat[];
};

/* ── beat builders ────────────────────────────────────────────────────────── */
const out = (line: Line): Beat => ({ kind: 'out', line });
const blank = (): Beat => out([]);
const okLine = (...spans: Span[]): Beat => out(ok(...spans));
const nav = (page: PageId): Beat => ({ kind: 'nav', page });
const fx = (run: (api: DirectorApi) => void): Beat => ({ kind: 'fx', run });
const wait = (ms: number): Beat => ({ kind: 'wait', ms });

export const PROJECT = 'acme-ops';

/** Exact prompt of a scripted scenario, so `runChat` matches + renders it. */
const chat = (id: string): string => SCENARIOS.find((s) => s.id === id)?.prompt ?? '';

/** The model the demo rests on before the CLI switches providers. */
export const DEFAULT_MODEL: ActiveModel = { domain: 'anthropic.com', name: 'Claude Opus 4.8' };

/** First chat the loop runs (also the reduced-motion settle). No longer the deck. */
export const CHAT_PROMPT = chat('pipeline');

/** End state after the full tour — shared by the loop bookend and reduced-motion. */
export const SETTLED: {
  projects: ProjectCard[];
  model: ActiveModel;
  connectedProviders: string[];
  connectors: string[];
  scheduleAdded: boolean;
  secretAdded: boolean;
  memberAdded: boolean;
  slack: { connected: boolean; workspace: string };
} = {
  projects: [
    {
      name: PROJECT,
      status: 'live',
      files: 9,
      branch: 'main',
      repo: `git.kortix.com/acme/${PROJECT}`,
      url: `kortix.com/p/${PROJECT}`,
    },
  ],
  model: { domain: 'openai.com', name: 'GPT-5' },
  connectedProviders: ['openai.com'],
  connectors: ['Linear', 'Notion'],
  scheduleAdded: true,
  secretAdded: true,
  memberAdded: true,
  slack: { connected: true, workspace: 'Acme' },
};

export const SCRIPT: Command[] = [
  /* 1 ── kortix init → a draft project appears on the Projects tab ─────────── */
  {
    input: `kortix init ${PROJECT}`,
    beats: [
      nav('projects'),
      wait(260),
      blank(),
      out([
        t('Initialized Kortix project '),
        t(`"${PROJECT}"`, 'fg'),
        t(' in '),
        t(`~/${PROJECT}`, 'faded'),
      ]),
      fx((a) => a.addProject({ name: PROJECT, status: 'draft', files: 9, branch: 'main' })),
      out([t('Wrote 9 files:')]),
      out([t('  + ', 'faded'), t('kortix.toml')]),
      out([t('  + ', 'faded'), t('.kortix/opencode/agents/kortix.md')]),
      out([t('  + ', 'faded'), t('.claude/skills/kortix/SKILL.md')]),
      out([t('  + ', 'faded'), t('…and 6 more', 'faded')]),
      out([t('Git: initialized (main)', 'dim')]),
      blank(),
      out([t('Next:')]),
      out([t(`  cd ${PROJECT}`, 'fg')]),
      wait(850),
    ],
  },

  /* 2 ── kortix ship → the draft flips shipping → live ─────────────────────── */
  {
    input: 'kortix ship',
    beats: [
      nav('projects'),
      wait(220),
      fx((a) => a.setProjectStatus(PROJECT, 'shipping')),
      okLine(t('kortix.toml verified')),
      blank(),
      out([t('  '), t('kortix ship', 'kortix'), t('  new project → managed Kortix git', 'dim')]),
      out(meta('name', PROJECT, 'fg')),
      blank(),
      wait(450),
      okLine(t('Committed: '), t('kortix: ship', 'fg')),
      okLine(t('Pushed '), t('main', 'fg'), t(' → '), t('origin/main', 'fg')),
      okLine(t('Shipped '), t(PROJECT, 'fg')),
      fx((a) =>
        a.patchProject(PROJECT, {
          status: 'live',
          repo: `git.kortix.com/acme/${PROJECT}`,
          url: `kortix.com/p/${PROJECT}`,
        }),
      ),
      out(meta('repo', `git.kortix.com/acme/${PROJECT}`)),
      out([t('  live  ', 'dim'), t(`kortix.com/p/${PROJECT}`, 'cyan')]),
      wait(1050),
    ],
  },

  /* 3 ── connectors connect → Integrations: Linear connects ───────────────── */
  {
    input: 'kortix connectors connect linear',
    beats: [
      nav('integrations'),
      wait(260),
      out([t('  Open this URL to authorize:', 'dim')]),
      out([t('  https://pipedream.com/connect?token=ctok_9f2a…', 'cyan')]),
      wait(700),
      fx((a) => a.connectConnector('Linear')),
      okLine(t('linear', 'fg'), t(' connected '), t('(apn_3kf2)', 'faded')),
      wait(800),
    ],
  },

  /* 4 ── connectors connect → Integrations: Notion connects ───────────────── */
  {
    input: 'kortix connectors connect notion',
    beats: [
      nav('integrations'),
      wait(220),
      out([t('  Open this URL to authorize:', 'dim')]),
      out([t('  https://pipedream.com/connect?token=ctok_a7d1…', 'cyan')]),
      wait(700),
      fx((a) => a.connectConnector('Notion')),
      okLine(t('notion', 'fg'), t(' connected '), t('(apn_b81d)', 'faded')),
      wait(950),
    ],
  },

  /* 5 ── providers login → Models: OpenAI connects, active model switches ──── */
  {
    input: 'kortix providers login openai',
    beats: [
      nav('models'),
      wait(260),
      out([t('  Authorize ', 'dim'), t('openai', 'fg')]),
      out([t('  Opened browser · code ', 'dim'), t('GXTR-9F2K', 'fg')]),
      wait(750),
      fx((a) => {
        a.connectProvider('openai.com');
        a.setModel({ domain: 'openai.com', name: 'GPT-5' });
      }),
      okLine(t('Authorized '), t('openai', 'fg'), t(' on this project')),
      out([t('  active model → ', 'dim'), t('GPT-5', 'fg')]),
      wait(1050),
    ],
  },

  /* 6 ── sessions new → Chat: pipeline scenario ───────────────────────────── */
  {
    input: `kortix sessions new --prompt "Summarize this week's pipeline…"`,
    beats: [
      okLine(t('Session started '), t('1f3a', 'fg')),
      out([t('  status  ', 'dim'), t('provisioning', 'amber')]),
      out([t('  branch  ', 'dim'), t('session-1f3a', 'faded')]),
      nav('chat'),
      fx((a) => a.runChat(chat('pipeline'))),
      wait(2000),
      out([t('  ▸ ', 'cyan'), t('hubspot.search ', 'fg'), t('deals ≤ 7d', 'faded')]),
      wait(2500),
      okLine(t('7 deals advanced '), t('· 2 slipped', 'faded')),
      wait(1300),
    ],
  },

  /* 7 ── chat → Chat: repos scenario ──────────────────────────────────────── */
  {
    input: `kortix chat --prompt "What changed in our repos since Monday?"`,
    beats: [
      okLine(t('session '), t('repo-changes', 'fg'), t(' · streaming', 'dim')),
      nav('chat'),
      fx((a) => a.runChat(chat('repos'))),
      wait(2000),
      out([t('  ▸ ', 'cyan'), t('github.list_commits ', 'fg'), t('kortix-ai/kortix', 'faded')]),
      wait(2500),
      okLine(t('34 commits '), t('across 5 repos', 'faded')),
      wait(1300),
    ],
  },

  /* 8 ── chat → Chat: finance scenario (tool + email) ─────────────────────── */
  {
    input: `kortix chat --prompt "Run the weekly finance report and email the team…"`,
    beats: [
      okLine(t('session '), t('finance-weekly', 'fg'), t(' · streaming', 'dim')),
      nav('chat'),
      fx((a) => a.runChat(chat('finance'))),
      wait(2000),
      out([t('  ▸ ', 'cyan'), t('query_warehouse ', 'fg'), t('finance.weekly', 'faded')]),
      wait(1600),
      out([t('  ▸ ', 'cyan'), t('gmail.send ', 'fg'), t('finance@acme.ai', 'faded')]),
      wait(1700),
      okLine(t('Weekly finance report sent '), t('· 6 recipients', 'faded')),
      wait(1300),
    ],
  },

  /* 9 ── triggers add → Scheduling: a cron job appears ────────────────────── */
  {
    input: `kortix triggers add daily-briefing --cron "0 8 * * *"`,
    beats: [
      nav('scheduling'),
      wait(280),
      fx((a) => a.addSchedule()),
      okLine(t('Added [[triggers]] '), t('daily-briefing', 'fg'), t(' (cron) to kortix.toml')),
      out([t('  0 8 * * *  ', 'faded'), t('every day · 08:00', 'dim')]),
      wait(1300),
    ],
  },

  /* 10 ── secrets set → Security: a secret lands in the vault ─────────────── */
  {
    input: 'kortix secrets set SENDGRID_API_KEY=SG.•••',
    beats: [
      nav('security'),
      wait(280),
      fx((a) => a.addSecret()),
      okLine(t('SENDGRID_API_KEY', 'fg')),
      out([t('  encrypted → ', 'dim'), t('project_secrets', 'faded')]),
      wait(1100),
    ],
  },

  /* 11 ── access invite → Security: a teammate is invited ─────────────────── */
  {
    input: 'kortix access invite alex@acme.ai --role member',
    beats: [
      nav('security'),
      wait(220),
      fx((a) => a.inviteMember()),
      okLine(t('Invited '), t('alex@acme.ai', 'fg'), t(' as member '), t('(pending signup)', 'faded')),
      wait(1400),
    ],
  },

  /* 12 ── channels connect → Channels: Slack goes live ────────────────────── */
  {
    input: 'kortix channels connect',
    beats: [
      nav('channels'),
      wait(280),
      fx((a) => a.connectSlack('Acme')),
      okLine(t('Connected to '), t('Acme', 'fg')),
      out([t('  team     ', 'dim'), t('T0ACME', 'faded')]),
      out([t('  webhook  ', 'dim'), t('api.kortix.com/v1/webhooks/slack/1f3a', 'faded')]),
      wait(2400),
    ],
  },
];
