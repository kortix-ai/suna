/**
 * The chat platforms whose senders pass an allow-list (channels/core/channel-access.ts).
 * Each keeps its lists in `projects.metadata.<platform>`, and project reads hide every
 * key named here (projects/lib/serializers.ts).
 */
import type { CHANNEL_PLATFORMS } from '@kortix/manifest-schema';

export const CHANNEL_ACCESS_PLATFORMS = ['telegram'] as const satisfies readonly (typeof CHANNEL_PLATFORMS)[number][];
export type ChannelAccessPlatform = (typeof CHANNEL_ACCESS_PLATFORMS)[number];
