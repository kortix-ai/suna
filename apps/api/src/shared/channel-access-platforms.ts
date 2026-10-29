/**
 * The chat platforms whose senders pass an allow-list (channels/core/channel-access.ts).
 * Each keeps its lists in `projects.metadata.<platform>`, and project reads hide every
 * key named here (projects/lib/serializers.ts).
 */
import { CHANNEL_PLATFORM_IDS, CHANNELS, type ChannelPlatformId } from '@kortix/shared/channel-descriptors';

/** The ids whose descriptor has `access`. */
export type ChannelAccessPlatform = {
  [P in ChannelPlatformId]: (typeof CHANNELS)[P] extends { access: object } ? P : never;
}[ChannelPlatformId];
export const CHANNEL_ACCESS_PLATFORMS: readonly ChannelAccessPlatform[] = CHANNEL_PLATFORM_IDS.filter(
  (p): p is ChannelAccessPlatform => 'access' in CHANNELS[p],
);
