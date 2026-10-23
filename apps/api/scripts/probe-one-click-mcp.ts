#!/usr/bin/env bun
/**
 * Regenerates `src/connectors/one-click-mcp.json`: every remote MCP server in
 * the integrations.sh catalogue that a generic MCP client connects to with its
 * URL alone. The Discover catalogue marks those entries `oneClick`.
 *
 * Each endpoint gets an unauthenticated `initialize`:
 *   none  initialize + tools/list answer without a credential
 *   dcr   401 → RFC 9728 protected-resource metadata → the authorization
 *         server lists `registration_endpoint` (RFC 7591)
 *   cimd  the authorization server sets `client_id_metadata_document_supported`
 * Everything else (an own OAuth app, an API key, a 403 edge wall, dead) is left
 * out. `*.googleapis.com` answers initialize openly but needs a Google Cloud
 * project for every tool call, so it is left out too. No OAuth client is
 * registered anywhere: the verdict reads published metadata only.
 *
 *   bun apps/api/scripts/probe-one-click-mcp.ts   (~2 min, 32 parallel probes)
 */
const output = new URL("../src/connectors/one-click-mcp.json", import.meta.url)
  .pathname;
const TIMEOUT = 12_000;
const CONCURRENCY = 32;

const H = {
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
};
const rpc = (id: number, method: string, params: object = {}) =>
  JSON.stringify({ jsonrpc: "2.0", id, method, params });
const INIT = rpc(1, "initialize", {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "mcp-oneclick-audit", version: "1" },
});

const req = (url: string, init: RequestInit = {}) =>
  fetch(url, {
    ...init,
    signal: AbortSignal.timeout(TIMEOUT),
    redirect: "follow",
  }).catch((e: Error) => e);

const json = async (url: string) => {
  const r = await req(url, { headers: { accept: "application/json" } });
  if (r instanceof Error || !r.ok) return undefined;
  return r.json().catch(() => undefined) as Promise<
    Record<string, any> | undefined
  >;
};

const rpcResult = (body: string) => {
  const frames = body.includes("data:")
    ? body
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5))
    : [body];
  for (const f of frames) {
    try {
      const p = JSON.parse(f);
      if (p?.result || p?.error) return p;
    } catch {}
  }
  return undefined;
};

/** RFC 9728 §3.1: insert the well-known segment between host and path. */
const wellKnown = (url: string, name: string) => {
  const u = new URL(url);
  const path = u.pathname.replace(/\/$/, "");
  return [
    ...new Set([
      `${u.origin}/.well-known/${name}${path}`,
      `${u.origin}/.well-known/${name}`,
    ]),
  ];
};

async function authServerMeta(issuer: string) {
  const cands = [
    ...wellKnown(issuer, "oauth-authorization-server"),
    ...wellKnown(issuer, "openid-configuration"),
  ];
  const u = new URL(issuer);
  cands.push(
    `${u.origin}${u.pathname.replace(/\/$/, "")}/.well-known/openid-configuration`,
  );
  for (const c of new Set(cands)) {
    const m = await json(c);
    if (m?.authorization_endpoint || m?.token_endpoint)
      return { url: c, meta: m };
  }
  return undefined;
}

async function classify(url: string) {
  const r = await req(url, { method: "POST", headers: H, body: INIT });
  if (r instanceof Error) {
    const m = r.message.toLowerCase();
    const dead =
      /dns|getaddrinfo|enotfound|refused|unable to connect|certificate|invalid/.test(
        m,
      );
    return {
      verdict: dead ? "dead" : "unknown",
      detail: r.message.slice(0, 120),
    };
  }
  const www = r.headers.get("www-authenticate") ?? "";
  const body = await r.text().catch(() => "");

  if (r.ok) {
    const init = rpcResult(body);
    if (!init?.result?.protocolVersion)
      return { verdict: "dead", detail: `HTTP ${r.status}, not MCP` };
    const sid = r.headers.get("mcp-session-id");
    const h = {
      ...H,
      ...(sid ? { "mcp-session-id": sid } : {}),
      "mcp-protocol-version": init.result.protocolVersion,
    };
    await req(url, {
      method: "POST",
      headers: h,
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized",
      }),
    });
    const t = await req(url, {
      method: "POST",
      headers: h,
      body: rpc(2, "tools/list"),
    });
    if (t instanceof Error)
      return {
        verdict: "unknown",
        detail: `initialize ok, tools/list ${t.message.slice(0, 60)}`,
      };
    const tb = rpcResult(await t.text().catch(() => ""));
    if (t.status === 401 || t.status === 403)
      return {
        verdict: "oauth_pending",
        detail: "initialize ok, tools/list 401",
        www: t.headers.get("www-authenticate") ?? "",
      };
    const tools = tb?.result?.tools?.length;
    if (tools !== undefined)
      return {
        verdict: "authless",
        detail: `initialize + tools/list ok`,
        tools,
      };
    return {
      verdict: "authless",
      detail: `initialize ok, tools/list ${t.status}${tb?.error ? " " + String(tb.error.message).slice(0, 60) : ""}`,
    };
  }
  if (r.status === 401 || r.status === 403)
    return { verdict: "oauth_pending", detail: `HTTP ${r.status}`, www };
  if ([404, 405, 410].includes(r.status))
    return { verdict: "dead", detail: `HTTP ${r.status}` };
  return { verdict: "unknown", detail: `HTTP ${r.status}` };
}

async function probe(url: string) {
  const base = await classify(url);
  if (base.verdict !== "oauth_pending") return base;
  const prmFromHeader = /resource_metadata="?([^",\s]+)"?/i.exec(
    base.www ?? "",
  )?.[1];
  let prm: Record<string, any> | undefined;
  let prmUrl: string | undefined;
  for (const c of [
    prmFromHeader,
    ...wellKnown(url, "oauth-protected-resource"),
  ].filter(Boolean) as string[]) {
    prm = await json(c);
    if (prm) {
      prmUrl = c;
      break;
    }
  }
  // Pre-2025-06 servers skip PRM and serve AS metadata on the MCP origin itself.
  const issuer = prm?.authorization_servers?.[0] ?? new URL(url).origin;
  const as = await authServerMeta(issuer);
  if (!as)
    return {
      verdict: "key",
      detail: `${base.detail}, no OAuth metadata`,
      www: base.www?.slice(0, 160),
    };
  const m = as.meta;
  const common = {
    issuer: m.issuer ?? issuer,
    prm: prmUrl,
    asMeta: as.url,
    registration: m.registration_endpoint,
    cimd: m.client_id_metadata_document_supported === true,
    pkce: m.code_challenge_methods_supported,
    scopes: (prm?.scopes_supported ?? m.scopes_supported)?.slice?.(0, 12),
  };
  if (m.registration_endpoint)
    return { verdict: "oauth_dcr", detail: base.detail, ...common };
  if (common.cimd)
    return { verdict: "oauth_cimd", detail: base.detail, ...common };
  return {
    verdict: "oauth_byo",
    detail: `${base.detail}, AS has no registration_endpoint`,
    ...common,
  };
}

const data = (
  (await (await fetch("https://integrations.sh/api.json")).json()) as {
    data: any[];
  }
).data;
const urls = [
  ...new Set(
    data
      .filter((x) => x.kind === "mcp" && x.connectUrl)
      .map((x) => x.connectUrl.trim()),
  ),
];
const out: Record<string, any> = {};
let done = 0;
const queue = [...urls];
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    for (let u = queue.shift(); u; u = queue.shift()) {
      let v;
      try {
        new URL(u);
        v = /[{}]/.test(u)
          ? { verdict: "dead", detail: "placeholder url" }
          : await probe(u);
        // A timeout or 5xx is a bad minute, not a verdict: one more try.
        if (v.verdict === "unknown") v = await probe(u);
      } catch (e) {
        v = {
          verdict: "dead",
          detail: `invalid url ${String(e).slice(0, 60)}`,
        };
      }
      out[u] = { ...v, checkedAt: new Date().toISOString() };
      if (++done % 100 === 0) console.error(`${done}/${urls.length}`);
    }
  }),
);
const servers: Record<string, "none" | "dcr" | "cimd"> = {};
const kinds = {
  authless: "none",
  oauth_dcr: "dcr",
  oauth_cimd: "cimd",
} as const;
for (const url of Object.keys(out).sort()) {
  const kind = kinds[out[url].verdict as keyof typeof kinds];
  const host = new URL(url).hostname;
  if (kind && !host.endsWith("googleapis.com") && host !== "api.anthropic.com")
    servers[url] = kind;
}
await Bun.write(
  output,
  JSON.stringify(
    { probedAt: new Date().toISOString(), probed: urls.length, servers },
    null,
    1,
  ) + "\n",
);
console.log(
  `${Object.keys(servers).length} one-click of ${urls.length} probed → ${output}`,
);
