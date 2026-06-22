import type { ChannelPlatform, ConnectorSpec } from '../projects/connectors';
import { loadSlackInstall, loadTeamsInstall } from '../channels/install-store';
import { MANIFEST_FILENAME } from '../projects/triggers';
import { channelDefaultSlug, channelLabel } from './channels';

function channelSpec(platform: ChannelPlatform, slug: string): ConnectorSpec {
  return {
    slug,
    path: `${MANIFEST_FILENAME}#connectors.${slug} (auto: ${platform} install)`,
    name: channelLabel(platform),
    enabled: true,
    provider: 'channel',
    credentialMode: 'shared',
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

function channelAlreadyDeclared(
  declared: ConnectorSpec[],
  platform: ChannelPlatform,
  slug: string,
): boolean {
  return declared.some(
    (s) => s.slug === slug || (s.provider === 'channel' && s.platform === platform),
  );
}

export async function synthesizeChannelConnectors(
  projectId: string,
  declared: ConnectorSpec[],
): Promise<ConnectorSpec[]> {
  const out: ConnectorSpec[] = [];

  const slackSlug = channelDefaultSlug('slack');
  if (!channelAlreadyDeclared(declared, 'slack', slackSlug)) {
    const install = await loadSlackInstall(projectId).catch(() => null);
    if (install) out.push(channelSpec('slack', slackSlug));
  }

  const teamsSlug = channelDefaultSlug('teams');
  if (!channelAlreadyDeclared(declared, 'teams', teamsSlug)) {
    const install = await loadTeamsInstall(projectId).catch(() => null);
    if (install) out.push(channelSpec('teams', teamsSlug));
  }

  return out;
}
