/**
 * Auto-materialize channel connectors from platform installs.
 *
 * A channel connector (Slack today) doesn't need a `[[connectors]]` entry in
 * kortix.toml — connecting the platform IS the registration. When a project has
 * a Slack install but hasn't explicitly declared a `channel` connector for it,
 * we synthesize a ConnectorSpec here so the materializer treats it like any
 * other connector: it gets DB rows, a fixed action catalog, sharing, policies,
 * and shows up in the Executor/Connectors surface. The credential is the
 * existing install token (resolved server-side at call time) — no copy, no
 * executor_credentials row, no migration. See KORTIX-206.
 */
import type { ChannelPlatform, ConnectorSpec } from '../projects/connectors';
import { channelLabel } from './channels';
import { loadSlackInstall, loadTeamsInstall } from '../channels/install-store';
import { MANIFEST_FILENAME } from '../projects/triggers';

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

/** True if a channel for `platform` (or anything on its default slug) is already declared. */
function alreadyDeclared(declared: ConnectorSpec[], platform: ChannelPlatform, slug: string): boolean {
  return declared.some((s) => s.slug === slug || (s.provider === 'channel' && s.platform === platform));
}

/**
 * Synthetic channel ConnectorSpecs for platforms this project has installed but
 * not explicitly declared in kortix.toml — connecting the platform IS the
 * registration. We never shadow an explicit declaration: a hand-written
 * `channel` connector (or anything already using the slug) keeps full control.
 */
export async function synthesizeChannelConnectors(
  projectId: string,
  declared: ConnectorSpec[],
): Promise<ConnectorSpec[]> {
  const out: ConnectorSpec[] = [];
  if (!alreadyDeclared(declared, 'slack', 'slack')) {
    const install = await loadSlackInstall(projectId).catch(() => null);
    if (install) out.push(channelSpec('slack', 'slack'));
  }
  if (!alreadyDeclared(declared, 'teams', 'teams')) {
    const install = await loadTeamsInstall(projectId).catch(() => null);
    if (install) out.push(channelSpec('teams', 'teams'));
  }
  return out;
}
