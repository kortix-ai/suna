import { and, desc, eq, inArray } from 'drizzle-orm';
import { chatInstalls, chatThreads, projects } from '@kortix/db';
import { db } from '../../shared/db';
import { loadSlackTokenForWorkspace } from '../install-store';
import { publishHomeView } from '../slack-api';
import { config } from '../../config';
import { escapeMrkdwn, formatRelativeTime, repoLabel, repoOgImage } from './util';
import type { HomeWorkspaceRow, HomeRecentRow } from './types';

export async function publishHomeForUser(teamId: string, userId: string): Promise<void> {
  const installs = await db
    .select({ workspaceId: chatInstalls.workspaceId })
    .from(chatInstalls)
    .where(and(eq(chatInstalls.platform, 'slack'), eq(chatInstalls.platformWorkspaceId, teamId)));
  if (installs.length === 0) return;

  const token = await loadSlackTokenForWorkspace(installs[0].workspaceId);
  if (!token) return;

  const workspaceIds = installs.map((install) => install.workspaceId);
  const workspaceRows = await db
    .select({ workspaceId: projects.workspaceId, name: projects.name, repoUrl: projects.repoUrl })
    .from(projects)
    .where(inArray(projects.workspaceId, workspaceIds));

  const recent = await db
    .select({
      workspaceId: chatThreads.workspaceId,
      lastMessageAt: chatThreads.lastMessageAt,
      threadId: chatThreads.threadId,
    })
    .from(chatThreads)
    .where(and(eq(chatThreads.platform, 'slack'), eq(chatThreads.platformWorkspaceId, teamId)))
    .orderBy(desc(chatThreads.lastMessageAt))
    .limit(5);

  const view = buildHomeView({ workspaces: workspaceRows, recent });
  await publishHomeView(token, userId, view);
}

const HOME_EXAMPLES: Array<{ emoji: string; prompt: string }> = [
  { emoji: '🔍', prompt: '@Kortix scan this codebase and write me a one-pager' },
  { emoji: '🔧', prompt: '@Kortix open a PR that switches our logger to pino' },
  { emoji: '📊', prompt: '@Kortix what changed on main this week?' },
  { emoji: '📦', prompt: '@Kortix pull yesterday\'s sign-ups, group them by source, drop the CSV here' },
];

const WORKSPACE_COVERS = [
  '1517694712202-14dd9538aa97',
  '1555066931-4365d14bab8c',
  '1542831371-29b0f74f9713',
  '1532619675605-1ede6c2ed2b0',
  '1551033406-611cf9a28f67',
  '1573164713988-8665fc963095',
  '1551288049-bebda4e38f71',
];

function workspaceCoverUrl(workspaceId: string): string {
  let h = 0;
  for (let i = 0; i < workspaceId.length; i++) h = (h * 31 + workspaceId.charCodeAt(i)) | 0;
  const idx = Math.abs(h) % WORKSPACE_COVERS.length;
  return `https://images.unsplash.com/photo-${WORKSPACE_COVERS[idx]}?w=1600&h=400&fit=crop&q=80&auto=format`;
}

const DEFAULT_HOME_HERO_URL =
  'https://images.unsplash.com/photo-1518770660439-4636190af475?w=1600&h=480&fit=crop&q=80&auto=format';

function buildHomeView(input: { workspaces: HomeWorkspaceRow[]; recent: HomeRecentRow[] }): Record<string, unknown> {
  const dashboardBase = (config.FRONTEND_URL || 'https://kortix.com').replace(/\/$/, '');
  const heroUrl = config.SLACK_HOME_HERO_URL || DEFAULT_HOME_HERO_URL;
  const blocks: Array<Record<string, unknown>> = [];

  blocks.push({
    type: 'image',
    image_url: heroUrl,
    alt_text: 'Kortix — AI command center for your company',
  });
  blocks.push({
    type: 'header',
    text: { type: 'plain_text', text: '👋  Welcome to Kortix', emoji: true },
  });
  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: [
        '*Your AI command center, right here in Slack.*',
        '',
        "`@`-mention me in any channel with a task and an agent gets on it — working across your connected tools and replying right in the thread. Follow-ups stay in context.",
      ].join('\n'),
    },
  });
  blocks.push({
    type: 'context',
    elements: [
      { type: 'mrkdwn', text: '⚡  *Live progress*' },
      { type: 'mrkdwn', text: '🧵  *Thread memory*' },
      { type: 'mrkdwn', text: '🔗  *Works across your tools*' },
      { type: 'mrkdwn', text: '🔒  *Secure & isolated*' },
    ],
  });

  blocks.push({ type: 'divider' });

  if (input.workspaces.length === 0) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: '*No workspaces connected yet.*\nHead to your Kortix dashboard to link a workspace to this workspace.' },
      accessory: {
        type: 'button',
        text: { type: 'plain_text', text: 'Open dashboard' },
        style: 'primary',
        url: dashboardBase,
        action_id: 'home_open_dashboard',
      },
    });
  } else {
    blocks.push({
      type: 'header',
      text: { type: 'plain_text', text: `Connected workspaces · ${input.workspaces.length}`, emoji: true },
    });
    for (const workspace of input.workspaces) {
      const label = repoLabel(workspace.repoUrl);
      // Cover image — full-width card hero.
      blocks.push({
        type: 'image',
        image_url: workspaceCoverUrl(workspace.workspaceId),
        alt_text: `${workspace.name} cover`,
      });
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: [
            `*${escapeMrkdwn(workspace.name)}*`,
            `<${workspace.repoUrl}|${escapeMrkdwn(label)}>`,
          ].join('\n'),
        },
      });
      blocks.push({
        type: 'context',
        elements: [
          { type: 'mrkdwn', text: '🟢  *Connected*' },
          { type: 'mrkdwn', text: `🪐  <${dashboardBase}/workspaces/${workspace.workspaceId}|Dashboard>` },
        ],
      });
      blocks.push({
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: 'Open workspace' },
            style: 'primary',
            url: `${dashboardBase}/workspaces/${workspace.workspaceId}`,
            action_id: `home_open_${workspace.workspaceId}`,
          },
          {
            type: 'button',
            text: { type: 'plain_text', text: 'View on GitHub' },
            url: workspace.repoUrl,
            action_id: `home_repo_${workspace.workspaceId}`,
          },
        ],
      });
    }
  }

  blocks.push({ type: 'divider' });
  blocks.push({
    type: 'header',
    text: { type: 'plain_text', text: 'Try a task', emoji: true },
  });
  blocks.push({
    type: 'section',
    text: { type: 'mrkdwn', text: '_Paste any of these into a channel I\'m in:_' },
  });
  for (const ex of HOME_EXAMPLES) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `${ex.emoji}  \`${ex.prompt}\`` },
    });
  }

  if (input.recent.length > 0) {
    const workspaceById = new Map(input.workspaces.map((workspace) => [workspace.workspaceId, workspace]));
    blocks.push({ type: 'divider' });
    blocks.push({
      type: 'header',
      text: { type: 'plain_text', text: 'Recent activity', emoji: true },
    });
    for (const r of input.recent) {
      const workspace = workspaceById.get(r.workspaceId);
      const workspaceName = workspace?.name ?? 'workspace';
      const when = formatRelativeTime(r.lastMessageAt);
      const elements: Array<Record<string, unknown>> = [];
      const og = workspace ? repoOgImage(workspace.repoUrl) : null;
      if (og) elements.push({ type: 'image', image_url: og, alt_text: `${workspaceName} repo` });
      elements.push({ type: 'mrkdwn', text: `*${escapeMrkdwn(workspaceName)}*  ·  ${when}` });
      blocks.push({ type: 'context', elements });
    }
  }

  blocks.push({ type: 'divider' });
  blocks.push({
    type: 'context',
    elements: [
      { type: 'mrkdwn', text: `🪐  Managed by Kortix  ·  <${dashboardBase}|kortix.com>  ·  <${dashboardBase}/docs|Docs>  ·  <${dashboardBase}/settings|Settings>` },
    ],
  });

  return { type: 'home', blocks };
}
