/**
 * Connector provider registry — the lookup the generic connector routes use to
 * dispatch onto a channel descriptor. Adding a new channel is: write a
 * descriptor, register it here. Nothing else in the route/SDK/UI surface changes.
 *
 * Slack, Teams, and Meet descriptors are registered as they are ported; email
 * is the proven first slice.
 */
import type { ChannelPlatform } from '../../projects/connectors';
import type { ConnectorProviderDescriptor } from './descriptor';
import { emailDescriptor } from './email';
import { slackDescriptor } from './slack';
import { teamsDescriptor } from './teams';
import { meetDescriptor } from './meet';

const DESCRIPTORS: readonly ConnectorProviderDescriptor[] = [
  slackDescriptor,
  teamsDescriptor,
  emailDescriptor,
  meetDescriptor,
];

const BY_PLATFORM = new Map<ChannelPlatform, ConnectorProviderDescriptor>(
  DESCRIPTORS.map((d) => [d.platform, d]),
);

/** All registered channel descriptors (registration order). */
export function listChannelDescriptors(): readonly ConnectorProviderDescriptor[] {
  return DESCRIPTORS;
}

/** Descriptor for a chat platform, or null if that platform isn't registered. */
export function descriptorForPlatform(
  platform: string,
): ConnectorProviderDescriptor | null {
  return BY_PLATFORM.get(platform as ChannelPlatform) ?? null;
}

export type { ConnectorProviderDescriptor } from './descriptor';
export { ChannelError } from './descriptor';
