import { and, desc, eq, inArray } from 'drizzle-orm';
import { chatInstalls, chatThreads, projects } from '@kortix/db';
import { db } from '../../shared/db';
import { loadSlackTokenForProject } from '../install-store';
import { publishHomeView } from '../slack-api';
import { config } from '../../config';
import { escapeMrkdwn, formatRelativeTime, repoLabel, repoOgImage } from './util';
import type { HomeProjectRow, HomeRecentRow } from './types';

export async function publishHomeForUser(teamId: string, userId: string): Promise<void> {
  const installs = await db
    .select({ projectId: chatInstalls.projectId })
    .from(chatInstalls)
    .where(and(eq(chatInstalls.platform, 'slack'), eq(chatInstalls.workspaceId, teamId)));
  if (installs.length === 0) return;

  const token = await loadSlackTokenForProject(installs[0].projectId);
  if (!token) return;

  const projectIds = installs.map((i) => i.projectId);
  const projectRows = await db
    .select({ projectId: projects.projectId, name: projects.name, repoUrl: projects.repoUrl })
    .from(projects)
    .where(inArray(projects.projectId, projectIds));

  const recent = await db
    .select({
      projectId: chatThreads.projectId,
      lastMessageAt: chatThreads.lastMessageAt,
      threadId: chatThreads.threadId,
    })
    .from(chatThreads)
    .where(and(eq(chatThreads.platform, 'slack'), eq(chatThreads.workspaceId, teamId)))
    .orderBy(desc(chatThreads.lastMessageAt))
    .limit(5);

  const view = buildHomeView({ projects: projectRows, recent });
  await publishHomeView(token, userId, view);
}

const HOME_EXAMPLES: Array<{ emoji: string; prompt: string }> = [
  { emoji: '🔍', prompt: '@Kortix scan this codebase and write me a one-pager' },
  { emoji: '🔧', prompt: '@Kortix open a PR that switches our logger to pino' },
  { emoji: '📊', prompt: '@Kortix what changed on main this week?' },
  { emoji: '📦', prompt: '@Kortix pull yesterday\'s sign-ups, group them by source, drop the CSV here' },
];

const PROJECT_COVERS = [
  '1517694712202-14dd9538aa97',
  '1555066931-4365d14bab8c',
  '1542831371-29b0f74f9713',
  '1532619675605-1ede6c2ed2b0',
  '1551033406-611cf9a28f67',
  '1573164713988-8665fc963095',
  '1551288049-bebda4e38f71',
];

function projectCoverUrl(projectId: string): string {
  let h = 0;
  for (let i = 0; i < projectId.length; i++) h = (h * 31 + projectId.charCodeAt(i)) | 0;
  const idx = Math.abs(h) % PROJECT_COVERS.length;
  return `https://images.unsplash.com/photo-${PROJECT_COVERS[idx]}?w=1600&h=400&fit=crop&q=80&auto=format`;
}

const DEFAULT_HOME_HERO_URL =
  'https://images.unsplash.com/photo-1518770660439-4636190af475?w=1600&h=480&fit=crop&q=80&auto=format';

function buildHomeView(input: { projects: HomeProjectRow[]; recent: HomeRecentRow[] }): Record<string, unknown> {
  const dashboardBase = (config.KORTIX_URL || 'https://kortix.com').replace(/\/$/, '');
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
        "`@`-mention me in any channel with a task and I'll read the repo, run the work in an isolated sandbox, and reply in the thread. Follow-ups stay in context.",
      ].join('\n'),
    },
  });
  blocks.push({
    type: 'context',
    elements: [
      { type: 'mrkdwn', text: '⚡  *Live plan streaming*' },
      { type: 'mrkdwn', text: '🧵  *Thread memory*' },
      { type: 'mrkdwn', text: '📁  *File I/O*' },
      { type: 'mrkdwn', text: '🔒  *Isolated sandbox*' },
    ],
  });

  blocks.push({ type: 'divider' });

  if (input.projects.length === 0) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: '*No projects connected yet.*\nHead to your Kortix dashboard to link a project to this workspace.' },
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
      text: { type: 'plain_text', text: `Connected projects · ${input.projects.length}`, emoji: true },
    });
    for (const p of input.projects) {
      const label = repoLabel(p.repoUrl);
      // Cover image — full-width card hero.
      blocks.push({
        type: 'image',
        image_url: projectCoverUrl(p.projectId),
        alt_text: `${p.name} cover`,
      });
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: [
            `*${escapeMrkdwn(p.name)}*`,
            `<${p.repoUrl}|${escapeMrkdwn(label)}>`,
          ].join('\n'),
        },
      });
      blocks.push({
        type: 'context',
        elements: [
          { type: 'mrkdwn', text: '🟢  *Connected*' },
          { type: 'mrkdwn', text: `🪐  <${dashboardBase}/projects/${p.projectId}|Dashboard>` },
        ],
      });
      blocks.push({
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: 'Open project' },
            style: 'primary',
            url: `${dashboardBase}/projects/${p.projectId}`,
            action_id: `home_open_${p.projectId}`,
          },
          {
            type: 'button',
            text: { type: 'plain_text', text: 'View on GitHub' },
            url: p.repoUrl,
            action_id: `home_repo_${p.projectId}`,
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
    const projectById = new Map(input.projects.map((p) => [p.projectId, p]));
    blocks.push({ type: 'divider' });
    blocks.push({
      type: 'header',
      text: { type: 'plain_text', text: 'Recent activity', emoji: true },
    });
    for (const r of input.recent) {
      const proj = projectById.get(r.projectId);
      const projectName = proj?.name ?? 'project';
      const when = formatRelativeTime(r.lastMessageAt);
      const elements: Array<Record<string, unknown>> = [];
      const og = proj ? repoOgImage(proj.repoUrl) : null;
      if (og) elements.push({ type: 'image', image_url: og, alt_text: `${projectName} repo` });
      elements.push({ type: 'mrkdwn', text: `*${escapeMrkdwn(projectName)}*  ·  ${when}` });
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
