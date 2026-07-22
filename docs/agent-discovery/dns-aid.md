# DNS-based agent discovery for kortix.com

Two agent-discovery affordances cannot be satisfied from this repository. This
document holds the exact artifacts so whoever has the access can apply them.

## DNS for AI Discovery (DNS-AID)

Per `draft-mozleywilliams-dnsop-dnsaid` and RFC 9460, publish ServiceMode
SVCB records under the `_agents` label. These point agents at the discovery
documents this repository already serves.

### Records

```
_index._agents.kortix.com. 3600 IN SVCB 1 kortix.com. (
    alpn="h2,h3"
    port=443
    endpoint="/.well-known/api-catalog" )

_a2a._agents.kortix.com.   3600 IN SVCB 1 kortix.com. (
    alpn="h2,h3"
    port=443
    endpoint="/.well-known/agent-skills/index.json" )
```

`_index` is the general entrypoint: it resolves to the API catalog, which in
turn links the OpenAPI document, the human docs, and the health endpoint.
`_a2a` resolves to the agent skills index.

### Cloudflare

Cloudflare's dashboard exposes SVCB under **DNS → Records → Add record → SVCB**.
Set Name to `_index._agents`, Priority to `1`, Target to `kortix.com`, and put
the parameters in the Value field as `alpn="h2,h3" port=443
endpoint="/.well-known/api-catalog"`. Repeat for `_a2a._agents`.

Via the API:

```bash
curl -X POST "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/dns_records" \
  -H "Authorization: Bearer $CF_API_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{
    "type": "SVCB",
    "name": "_index._agents.kortix.com",
    "ttl": 3600,
    "data": {
      "priority": 1,
      "target": "kortix.com",
      "value": "alpn=\"h2,h3\" port=443 endpoint=\"/.well-known/api-catalog\""
    }
  }'
```

### DNSSEC

The draft expects validating resolvers to return authenticated data, so the zone
must be signed. On Cloudflare: **DNS → Settings → DNSSEC → Enable**, then copy
the DS record it produces into the registrar for `kortix.com`. Discovery records
served from an unsigned zone are spoofable, which defeats the point of putting
them in DNS at all.

### Verifying

```bash
dig +short SVCB _index._agents.kortix.com
dig +dnssec SVCB _index._agents.kortix.com | grep -c RRSIG   # expect 1 or more
```

## MCP Server Card — not published

`/.well-known/mcp/server-card.json` (SEP-1649) is deliberately absent. There is
no MCP server anywhere in this repository: no `@modelcontextprotocol/*`
dependency, no transport endpoint, no tool registry. A card is a promise that an
agent will act on by connecting, so publishing one that points nowhere is worse
than publishing nothing.

Once an MCP transport endpoint exists, publish this document — filling in the
real endpoint URL and the capabilities the server actually implements:

```json
{
  "serverInfo": {
    "name": "kortix",
    "version": "1.0.0"
  },
  "transport": {
    "type": "streamable-http",
    "endpoint": "https://api.kortix.com/v1/mcp"
  },
  "capabilities": {
    "tools": {},
    "resources": {}
  }
}
```

Serve it the same way as the other discovery documents: a route handler under
`apps/web/src/app/(public)/well-known/mcp/server-card.json/`, plus a rewrite from
`/.well-known/mcp/server-card.json` in `next.config.ts`. Add `mcp-server-card` to
`DISCOVERY_PATHS` in `src/lib/agent-discovery/link-header.ts` at the same time so
the site-wide `Link` header advertises it.
