import { handlePublicContentMcp } from '@/lib/mcp/public-content-server';

export const dynamic = 'force-dynamic';

const CORS_HEADERS = {
  'Access-Control-Allow-Headers': 'Content-Type, Accept, MCP-Protocol-Version, MCP-Session-Id',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Expose-Headers': 'MCP-Protocol-Version',
  'Cache-Control': 'no-store',
  'MCP-Protocol-Version': '2025-03-26',
} as const;

export async function POST(request: Request) {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return Response.json(
      { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
      { status: 400, headers: CORS_HEADERS },
    );
  }

  if (Array.isArray(payload)) {
    return Response.json(
      {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32600, message: 'JSON-RPC batches are not supported' },
      },
      { status: 400, headers: CORS_HEADERS },
    );
  }

  const response = handlePublicContentMcp(payload && typeof payload === 'object' ? payload : {});
  if (response === null) return new Response(null, { status: 202, headers: CORS_HEADERS });
  return Response.json(response, { headers: CORS_HEADERS });
}

export function GET() {
  return Response.json(
    { error: 'Use POST for the MCP Streamable HTTP transport.' },
    { status: 405, headers: { ...CORS_HEADERS, Allow: 'POST, OPTIONS' } },
  );
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}
