import { discoveryJson, MCP_SERVER_CARD } from '@/lib/agent-discovery';

export const dynamic = 'force-static';

export function GET() {
  return discoveryJson(MCP_SERVER_CARD, 'application/mcp-server-card+json; charset=utf-8');
}

export const HEAD = GET;
