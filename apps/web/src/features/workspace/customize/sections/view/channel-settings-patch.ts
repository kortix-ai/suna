import type { ChannelBinding, UpdateChannelBindingInput } from '@/hooks/channels/use-channel-bindings';
import { modelKeyToWire } from '@kortix/sdk/react';

export type ChannelModelKey = { providerID: string; modelID: string } | null;

export interface ChannelSettings {
  /** null = the project default agent. */
  agentName: string | null;
  /** null = no pin: the default model chain. */
  model: ChannelModelKey;
  conversationPolicy: ChannelBinding['conversationPolicy'];
}

/**
 * The PATCH body for the channel settings dialog: only the fields that differ
 * from the binding as it is now. An empty object means there is nothing to
 * save. The route rejects an empty body (`empty_patch`), and sending an
 * unchanged model re-runs its servability check for nothing.
 */
export function channelSettingsPatch(
  bound: ChannelSettings,
  next: ChannelSettings,
): UpdateChannelBindingInput {
  const patch: UpdateChannelBindingInput = {};
  if (next.agentName !== bound.agentName) patch.agentName = next.agentName;
  if (next.model?.providerID !== bound.model?.providerID || next.model?.modelID !== bound.model?.modelID) {
    patch.opencodeModel = next.model ? modelKeyToWire(next.model) : null;
  }
  if (next.conversationPolicy !== bound.conversationPolicy) {
    patch.conversationPolicy = next.conversationPolicy;
  }
  return patch;
}
