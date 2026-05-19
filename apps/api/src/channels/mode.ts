import { config } from '../config';

export type ChannelsMode = 'single' | 'multi' | 'both' | 'off';
export type ChannelsModeFlag = 'auto' | 'single' | 'multi';

export interface ChannelsModeReport {
  mode: ChannelsMode;
  flag: ChannelsModeFlag;
  singleReady: boolean;
  multiReady: boolean;
  errors: string[];
}

export function resolveChannelsMode(): ChannelsModeReport {
  const flag = config.KORTIX_CHANNELS_MODE;
  const hasOauth = Boolean(
    config.SLACK_CLIENT_ID && config.SLACK_CLIENT_SECRET && config.SLACK_REDIRECT_URI,
  );

  let singleReady = flag !== 'multi';
  let multiReady = flag !== 'single' && hasOauth;

  const errors: string[] = [];
  if (flag === 'multi' && !multiReady) {
    errors.push('mode=multi requires SLACK_CLIENT_ID, SLACK_CLIENT_SECRET, SLACK_REDIRECT_URI');
  }

  let mode: ChannelsMode = 'off';
  if (singleReady && multiReady) mode = 'both';
  else if (singleReady) mode = 'single';
  else if (multiReady) mode = 'multi';

  return { mode, flag, singleReady, multiReady, errors };
}
