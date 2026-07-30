import { API_CATALOG, discoveryJson } from '@/lib/agent-discovery';

export const dynamic = 'force-static';

export function GET() {
  const response = discoveryJson(
    API_CATALOG,
    'application/linkset+json; charset=utf-8; profile="https://www.rfc-editor.org/info/rfc9727"',
  );
  response.headers.set(
    'Link',
    '</.well-known/api-catalog>; rel="api-catalog"; type="application/linkset+json"',
  );
  return response;
}

export const HEAD = GET;
