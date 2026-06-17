const DEFAULT_MANAGED_MODEL_IDS = [
  'anthropic/claude-opus-4.8',
  'anthropic/claude-sonnet-4.6',
  'openai/gpt-5.5',
  'google/gemini-3.5-flash',
  'google/gemini-3.1-pro-preview',
  'deepseek/deepseek-v4-flash',
  'deepseek/deepseek-v4-pro',
  'minimax/minimax-m3',
  'moonshotai/kimi-k2.6',
  'z-ai/glm-5.1',
  'x-ai/grok-4.3',
];

export function managedModelIds(): string[] {
  const raw = process.env.KORTIX_MANAGED_MODEL_IDS;
  if (!raw) return DEFAULT_MANAGED_MODEL_IDS;
  const ids = raw.split(',').map((id) => id.trim()).filter(Boolean);
  return ids.length ? ids : DEFAULT_MANAGED_MODEL_IDS;
}
