/**
 * Persist a channel connector (Slack today) into kortix.toml so it's a
 * first-class, git-tracked connector profile — not just an install-driven
 * synthetic row. Connecting Slack in the Channels tab writes
 * `[[connectors]] slug="kortix_slack" provider="channel" platform="slack"` here,
 * and disconnecting removes it.
 *
 * Best-effort by design: `synthesizeChannelConnectors` still materializes the
 * connector from the install at sync time, so a project whose repo is read-only
 * or unreachable keeps working — this only makes the profile EXPLICIT where one
 * can be written. It also converts a legacy channel entry declared under the old
 * public `slack` slug to the reserved `kortix_slack` slug (the rename that closes
 * the user-connector shadowing bug). See KORTIX-206.
 */
import { eq } from 'drizzle-orm';
import { projects } from '@kortix/db';
import { db } from '../shared/db';
import { commitManifest, loadManifestForEdit } from '../projects/index';
import type { ChannelPlatform } from '../projects/connectors';
import { channelDefaultSlug, channelLabel } from './channels';
import { withChannelDeclaration, withoutChannelDeclaration } from './channel-rules';

type Entry = Record<string, unknown>;

function connectorsOf(manifest: { raw: Record<string, unknown> }): Entry[] {
  return Array.isArray(manifest.raw.connectors) ? (manifest.raw.connectors as Entry[]) : [];
}

/**
 * Ensure kortix.toml declares the reserved channel connector for `platform`.
 * Idempotent — once declared, subsequent calls are a no-op (no commit). Returns
 * whether a commit was made. Never throws.
 */
export async function ensureChannelConnectorDeclared(
  projectId: string,
  platform: ChannelPlatform,
): Promise<boolean> {
  try {
    const [row] = await db.select().from(projects).where(eq(projects.projectId, projectId)).limit(1);
    if (!row) return false;
    const manifest = await loadManifestForEdit(row).catch(() => null);
    if (!manifest) return false;

    const slug = channelDefaultSlug(platform);
    const { connectors, changed } = withChannelDeclaration(
      connectorsOf(manifest),
      platform,
      slug,
      channelLabel(platform),
    );
    if (!changed) return false;
    manifest.raw.connectors = connectors;
    const res = await commitManifest(
      row,
      manifest,
      `chore: register ${platform} channel connector (${slug})`,
    );
    return 'ok' in res;
  } catch {
    return false;
  }
}

/**
 * Remove the reserved channel connector for `platform` from kortix.toml — the
 * platform was disconnected. Best-effort; never throws.
 */
export async function removeChannelConnectorDeclared(
  projectId: string,
  platform: ChannelPlatform,
): Promise<boolean> {
  try {
    const [row] = await db.select().from(projects).where(eq(projects.projectId, projectId)).limit(1);
    if (!row) return false;
    const manifest = await loadManifestForEdit(row).catch(() => null);
    if (!manifest) return false;

    const slug = channelDefaultSlug(platform);
    const { connectors, changed } = withoutChannelDeclaration(connectorsOf(manifest), platform, slug);
    if (!changed) return false;
    manifest.raw.connectors = connectors;
    const res = await commitManifest(
      row,
      manifest,
      `chore: deregister ${platform} channel connector (${slug})`,
    );
    return 'ok' in res;
  } catch {
    return false;
  }
}
