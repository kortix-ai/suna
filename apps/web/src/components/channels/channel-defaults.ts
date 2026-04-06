export const DEFAULT_CHANNEL_AGENT = 'kortix';

export function buildDefaultChannelInstructions(platform: 'telegram' | 'slack' | 'whatsapp', channelName?: string) {
  const label = channelName?.trim() || platform;
  return [
    `You are an AI agent responding via ${label}.`,
    'Keep responses concise and chat-appropriate.',
    'Use short paragraphs and short bullet points when helpful.',
    'Do not explain internal system behavior unless the user asks.',
    'If the user asks for actions, be direct and practical.',
  ].join(' ');
}
