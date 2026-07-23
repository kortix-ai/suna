import { agentSkillsIndex, discoveryJson } from '@/lib/agent-discovery';

export const dynamic = 'force-static';

export function GET() {
  return discoveryJson(agentSkillsIndex());
}

export const HEAD = GET;
