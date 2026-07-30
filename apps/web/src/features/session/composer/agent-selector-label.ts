import { HARNESSES, type HarnessId } from '@kortix/shared/harnesses';

const HARNESS_FAVICON_DOMAINS: Record<HarnessId, string> = {
  opencode: 'opencode.ai',
  claude: 'claude.ai',
  codex: 'openai.com',
  pi: 'pi.dev',
};

export function getAgentHarnessLabel(harness: HarnessId | null | undefined): string | null {
  return harness ? HARNESSES[harness].label : null;
}

export function getAgentHarnessFaviconDomain(harness: HarnessId | null | undefined): string | null {
  return harness ? HARNESS_FAVICON_DOMAINS[harness] : null;
}
