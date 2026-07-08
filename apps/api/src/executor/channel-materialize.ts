import { listAgentMailInstalls, loadMeetInstall, loadSlackInstall, loadTelegramInstall } from '../channels/install-store';
/**
 * Auto-materialize channel connectors from platform installs.
 *
 * A channel connector (Slack today) doesn't need a `connectors:` entry in
 * kortix.yaml — connecting the platform IS the registration. When a project has
 * a Slack install but hasn't explicitly declared a `channel` connector for it,
 * we synthesize a ConnectorSpec here so the materializer treats it like any
 * other connector: it gets DB rows, a fixed action catalog, policies, and
 * shows up in the Executor/Connectors surface. The credential is the
 * existing install token (resolved server-side at call time) — no copy, no
 * executor_credentials row, no migration. See KORTIX-206.
 */
import type { ChannelPlatform, ConnectorSpec } from '../projects/connectors';
import { MANIFEST_FILENAME } from '../projects/triggers';
import { channelDefaultSlug, channelLabel } from './channels';
import { db } from '../shared/db';
import { projects } from '@kortix/db';
import { eq } from 'drizzle-orm';
import { resolveExperimentalFeature } from '../experimental/features';

function channelSpec(platform: ChannelPlatform, slug: string, name = channelLabel(platform)): ConnectorSpec {
  return {
    slug,
    path: `${MANIFEST_FILENAME}#connectors.${slug} (auto: ${platform} install)`,
    name,
    enabled: true,
    provider: 'channel',
    credentialMode: 'shared',
    // Email is sensitive by default — reading a private inbox is an exfiltration
    // surface, so its actions ask before running (silence per-session with "allow
    // for session"). Slack/meet aren't gated by default.
    sensitive: platform === 'email',
    app: null,
    account: null,
    url: null,
    transport: null,
    endpoint: null,
    baseUrl: null,
    platform,
    spec: null,
    auth: { type: 'none', in: 'header', name: null, prefix: null, secret: null },
    policies: [],
  };
}

/** True if this platform is explicitly declared, or if anything owns the reserved slug. */
function channelAlreadyDeclared(
  declared: ConnectorSpec[],
  platform: ChannelPlatform,
  slug: string,
): boolean {
  if (platform === 'email') return declared.some((s) => s.slug === slug);
  return declared.some(
    (s) => s.slug === slug || (s.provider === 'channel' && s.platform === platform),
  );
}

/**
 * Synthetic channel ConnectorSpecs for platforms this project has installed but
 * not explicitly declared in kortix.yaml — connecting the platform IS the
 * registration. We never shadow an explicit declaration: a hand-written
 * `channel` connector (or anything already using the slug) keeps full control.
 */
export async function synthesizeChannelConnectors(
  projectId: string,
  declared: ConnectorSpec[],
): Promise<ConnectorSpec[]> {
  const specs: ConnectorSpec[] = [];

  // Slack (Telegram/Teams slot in here the same way — see KORTIX-206 Phase D).
  // Use the reserved platform-owned slug so user-defined connectors like
  // `[[connectors]] slug="slack" provider="pipedream" app="slack"` cannot
  // shadow the built-in Slack CLI's channel catalog.
  const slackSlug = channelDefaultSlug('slack');
  if (!channelAlreadyDeclared(declared, 'slack', slackSlug)) {
    const install = await loadSlackInstall(projectId).catch(() => null);
    if (install) specs.push(channelSpec('slack', slackSlug));
  }

  // Telegram — like Slack, a BYO-bot install IS the registration (optional
  // channel, no experimental gate: connecting is already the explicit opt-in).
  const telegramSlug = channelDefaultSlug('telegram');
  if (!channelAlreadyDeclared(declared, 'telegram', telegramSlug)) {
    const install = await loadTelegramInstall(projectId).catch(() => null);
    if (install) specs.push(channelSpec('telegram', telegramSlug));
  }

  const [project] = await db
    .select({ metadata: projects.metadata })
    .from(projects)
    .where(eq(projects.projectId, projectId))
    .limit(1);

  // Meet (Recall.ai) — gated on the per-project `meet` experimental flag. Like
  // Slack, a resolvable Recall key IS the registration (no OAuth / no [[connectors]]).
  if (project && resolveExperimentalFeature(project.metadata, 'meet')) {
    const meetSlug = channelDefaultSlug('meet');
    if (!channelAlreadyDeclared(declared, 'meet', meetSlug)) {
      const install = await loadMeetInstall(projectId).catch(() => null);
      if (install) specs.push(channelSpec('meet', meetSlug));
    }
  }

  if (!project || !resolveExperimentalFeature(project.metadata, 'agentmail_email')) {
    return specs;
  }

  const emailInstalls = await listAgentMailInstalls(projectId).catch(() => []);
  for (const install of emailInstalls) {
    const slug = install.profileSlug || channelDefaultSlug('email');
    if (!channelAlreadyDeclared(declared, 'email', slug)) {
      specs.push(channelSpec('email', slug, install.displayName || install.email || channelLabel('email')));
    }
  }

  return specs;
}
