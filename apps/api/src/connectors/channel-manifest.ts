/**
 * Persist a channel connector (Slack today) into kortix.yaml so it's a
 * first-class, git-tracked connector — not just an install-driven
 * synthetic row. Connecting Slack in the Channels tab writes a `connectors`
 * entry (`slug: kortix_slack`, `provider: channel`, `platform: slack`) here,
 * and disconnecting removes it.
 *
 * Best-effort by design: `synthesizeChannelConnectors` still materializes the
 * connector from the install at sync time, so a project whose repo is read-only
 * or unreachable keeps working — this only makes the connector EXPLICIT where one
 * can be written. It also converts a legacy channel entry declared under the old
 * public `slack` slug to the reserved `kortix_slack` slug (the rename that closes
 * the user-connector shadowing bug). See KORTIX-206.
 */
import { eq } from 'drizzle-orm';
import { projects } from '@kortix/db';
import { db } from '../shared/db';
import type { ChannelPlatform } from '../workspaces/connectors';
import { channelDefaultSlug, channelLabel } from './channels';
import { withChannelDeclaration, withoutChannelDeclaration } from './channel-rules';
import { mutateManifestWithRetry } from './manifest-mutation';

type Entry = Record<string, unknown>;

function connectorsOf(manifest: { raw: Record<string, unknown> }): Entry[] {
  return Array.isArray(manifest.raw.connectors) ? (manifest.raw.connectors as Entry[]) : [];
}

/**
 * Ensure kortix.yaml declares the reserved channel connector for `platform`.
 * Idempotent — once declared, subsequent calls are a no-op (no commit). Returns
 * whether a commit was made. Never throws.
 */
export async function ensureChannelConnectorDeclared(
  workspaceId: string,
  platform: ChannelPlatform,
  slug = channelDefaultSlug(platform),
  name = channelLabel(platform),
): Promise<boolean> {
  try {
    const [row] = await db.select().from(projects).where(eq(projects.workspaceId, workspaceId)).limit(1);
    if (!row) return false;
    let changed = false;
    const result = await mutateManifestWithRetry(
      row,
      `the ${platform} channel connector was being registered`,
      (manifest) => {
        const next = withChannelDeclaration(connectorsOf(manifest), platform, slug, name);
        changed = next.changed;
        if (!next.changed) return { ok: true, commitMessage: null };
        manifest.raw.connectors = next.connectors;
        return {
          ok: true,
          commitMessage: `chore: register ${platform} channel connector (${slug})`,
        };
      },
    );
    return result.ok && changed;
  } catch {
    return false;
  }
}

/**
 * Remove the reserved channel connector for `platform` from kortix.yaml — the
 * platform was disconnected. Best-effort; never throws.
 */
export async function removeChannelConnectorDeclared(
  workspaceId: string,
  platform: ChannelPlatform,
  slug = channelDefaultSlug(platform),
): Promise<boolean> {
  try {
    const [row] = await db.select().from(projects).where(eq(projects.workspaceId, workspaceId)).limit(1);
    if (!row) return false;
    let changed = false;
    const result = await mutateManifestWithRetry(
      row,
      `the ${platform} channel connector was being deregistered`,
      (manifest) => {
        const next = withoutChannelDeclaration(connectorsOf(manifest), platform, slug);
        changed = next.changed;
        if (!next.changed) return { ok: true, commitMessage: null };
        manifest.raw.connectors = next.connectors;
        return {
          ok: true,
          commitMessage: `chore: deregister ${platform} channel connector (${slug})`,
        };
      },
    );
    return result.ok && changed;
  } catch {
    return false;
  }
}
