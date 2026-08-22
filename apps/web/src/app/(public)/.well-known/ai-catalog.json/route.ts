import { AI_CATALOG, discoveryJson } from '@/lib/agent-discovery';

export const dynamic = 'force-static';

export function GET() {
  return discoveryJson(AI_CATALOG, 'application/ai-catalog+json; charset=utf-8');
}

export const HEAD = GET;
