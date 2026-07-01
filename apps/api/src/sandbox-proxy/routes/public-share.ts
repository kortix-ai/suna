import { Hono } from "hono";
import { Effect } from "effect";
import { effectMiddleware } from "../../effect/hono";
import { getTraceHeaders } from "../../lib/request-context";
import {
  PUBLIC_SHARE_BLOCKED_PORTS,
  STATIC_FILE_SHARE_PORT,
  resolvePublicShare,
  touchPublicShare,
} from "../../shared/session-public-shares";
import {
  buildSandboxUpstreamHeaders,
  invalidatePreviewLink,
  loadSandbox,
  markSandboxUsed,
  resolvePreviewLink,
  wakeSandbox,
} from "../backend";
import {
  attemptProxy,
  failJson,
  jsonResult,
  runProxyRouteEffect,
  runProxyValueEffect,
} from "./effect-workflows";

const publicShareApp = new Hono();
publicShareApp.use("*", effectMiddleware);

const STRIP_FORWARD_HEADERS = new Set([
  "host",
  "authorization",
  "cookie",
  "traceparent",
  "x-request-id",
  "accept-encoding",
]);

const VIEW_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function stripFrameAncestors(csp: string): string | null {
  const kept = csp
    .split(";")
    .map((d) => d.trim())
    .filter((d) => d && !/^frame-ancestors(\s|$)/i.test(d));
  return kept.length ? kept.join("; ") : null;
}

function publicResponseHeaders(
  upstreamHeaders: Headers,
  origin: string,
): Headers {
  const headers = new Headers(upstreamHeaders);
  headers.delete("x-frame-options");
  for (const key of [
    "content-security-policy",
    "content-security-policy-report-only",
  ]) {
    const csp = headers.get(key);
    if (csp && /frame-ancestors/i.test(csp)) {
      const next = stripFrameAncestors(csp);
      if (next) headers.set(key, next);
      else headers.delete(key);
    }
  }
  headers.set("Referrer-Policy", "no-referrer");
  if (origin) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Access-Control-Allow-Credentials", "false");
  }
  return headers;
}

function normalizeProxyPath(value: string | undefined): string {
  if (!value || value === "/") return "/";
  return value.startsWith("/") ? value : `/${value}`;
}

function publicOrigin(c: any): string {
  const url = new URL(c.req.url);
  const host = c.req.header("host") || url.host;
  const proto =
    c.req.header("x-forwarded-proto") || url.protocol.replace(":", "");
  return `${proto}://${host}`;
}

const resolvePublicShareRowEffect = (token: string) =>
  Effect.gen(function* () {
    const resolved = yield* attemptProxy(() => resolvePublicShare(token));
    if (!resolved.ok)
      return yield* failJson({ error: resolved.error }, resolved.status);
    return resolved.row;
  });

const publicShareMetadataWorkflow = (c: any, token: string) =>
  Effect.gen(function* () {
    const row = yield* resolvePublicShareRowEffect(token);
    const proxyPath =
      row.resourceType === "file"
        ? `/v1/p/public-share/${token}/file`
        : `/v1/p/public-share/${token}/${row.port}${row.path}`;
    // Path-based absolute URL only. The subdomain form (p{port}-{id}.{host}) has
    // no wildcard DNS in production, so it never resolves — always serve the
    // token-gated proxy path that the proxy routes below actually handle.
    const publicUrl =
      row.resourceType === "preview" ? `${publicOrigin(c)}${proxyPath}` : null;
    return jsonResult({
      share: {
        share_id: row.shareId,
        session_id: row.sessionId,
        project_id: row.projectId,
        resource_type: row.resourceType,
        label: row.label,
        port: row.port,
        path: row.path,
        file_path: row.filePath,
        mode: row.mode,
        allow_websocket: row.allowWebsocket,
        sandbox_status: row.sandboxStatus,
        expires_at: row.expiresAt?.toISOString() ?? null,
        proxy_path: proxyPath,
        public_url: publicUrl,
      },
    });
  });

publicShareApp.get("/:token", async (c) => {
  const token = c.req.param("token");
  return runProxyRouteEffect(c, publicShareMetadataWorkflow(c, token));
});

const publicShareForwardPrepEffect = (
  c: any,
  args: {
    share: any;
    port: number;
  },
) =>
  Effect.gen(function* () {
    const method = c.req.method.toUpperCase();
    if (args.share.resourceType === "file" && !VIEW_METHODS.has(method)) {
      return yield* failJson({ error: "This public share is view-only" }, 405);
    }

    const sandbox = yield* attemptProxy(() =>
      loadSandbox(args.share.externalId!),
    );
    if (!sandbox) return yield* failJson({ error: "Sandbox not found" }, 404);
    if (sandbox.status !== "active") {
      return yield* failJson(
        { error: "Sandbox is not running", status: sandbox.status },
        503,
      );
    }

    const origin = c.req.header("Origin") || "";
    const body =
      method !== "GET" && method !== "HEAD"
        ? yield* attemptProxy(
            () => c.req.raw.clone().arrayBuffer() as Promise<ArrayBuffer>,
          )
        : undefined;

    return { method, sandbox, origin, body };
  });

async function forwardPublicShare(
  c: any,
  args: {
    token: string;
    share: any;
    port: number;
    remainingPath: string;
    queryString: string;
    redirectPrefix: string;
  },
) {
  const prepared = await runProxyValueEffect(
    c,
    publicShareForwardPrepEffect(c, args),
  );
  if (prepared.kind === "response") return prepared.response;
  const { method, sandbox, origin, body } = prepared.value;

  const maxRetries = 2;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const { url: previewUrl, token: previewToken } = await resolvePreviewLink(
        args.share.externalId!,
        args.port,
      );
      const targetUrl =
        previewUrl.replace(/\/$/, "") + args.remainingPath + args.queryString;
      const headers = new Headers();
      for (const [key, value] of c.req.raw.headers.entries()) {
        if (STRIP_FORWARD_HEADERS.has(key.toLowerCase())) continue;
        headers.set(key, value);
      }
      headers.set("Accept-Encoding", "identity");
      for (const [key, value] of Object.entries(getTraceHeaders())) {
        headers.set(key, value);
      }
      const authHeaders = await buildSandboxUpstreamHeaders({
        sandboxId: args.share.externalId!,
        userId: "",
        serviceKey: sandbox.serviceKey,
        previewToken,
      });
      for (const [key, value] of Object.entries(authHeaders)) {
        headers.set(key, value);
      }
      const previewOrigin = new URL(previewUrl);
      if (headers.has("origin")) headers.set("origin", previewOrigin.origin);
      headers.set("x-forwarded-host", previewOrigin.host);
      headers.set(
        "X-Forwarded-Prefix",
        `${publicOrigin(c)}${args.redirectPrefix}`,
      );

      const upstream = await fetch(targetUrl, {
        method,
        headers,
        body,
        redirect: "manual",
        // Bun/undici streaming extensions — not in the lib RequestInit type.
        decompress: false,
        duplex: "half",
      } as RequestInit);

      if (
        (upstream.status === 502 || upstream.status === 503) &&
        attempt < maxRetries
      ) {
        invalidatePreviewLink(args.share.externalId!, args.port);
        await wakeSandbox(args.share.externalId!);
        await new Promise((r) => setTimeout(r, 1500));
        continue;
      }

      void markSandboxUsed(args.share.externalId!);
      void touchPublicShare(args.share.shareId).catch(() => {});

      return new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: publicResponseHeaders(upstream.headers, origin),
      });
    } catch (err) {
      if (attempt >= maxRetries) {
        return c.json(
          {
            error: "Sandbox upstream unreachable",
            detail: (err as Error).message,
          },
          502,
        );
      }
      await wakeSandbox(args.share.externalId!);
    }
  }

  return c.json({ error: "Sandbox upstream unreachable" }, 502);
}

function fileOpenQuery(filePath: string): string {
  return `?path=${encodeURIComponent(filePath)}`;
}

function assertFileShare(share: any) {
  if (share.resourceType !== "file" || !share.filePath) {
    return { ok: false as const };
  }
  return { ok: true as const, filePath: share.filePath as string };
}

async function forwardFileShare(
  c: any,
  args: {
    token: string;
    share: any;
    remainingPath: string;
    queryString: string;
  },
) {
  const file = assertFileShare(args.share);
  if (!file.ok) return c.json({ error: "Not authorized for this file" }, 403);

  const isFileEntry = args.remainingPath === "/";
  return forwardPublicShare(c, {
    token: args.token,
    share: args.share,
    port: STATIC_FILE_SHARE_PORT,
    remainingPath: isFileEntry ? "/open" : args.remainingPath,
    queryString: isFileEntry ? fileOpenQuery(file.filePath) : args.queryString,
    redirectPrefix: `/v1/p/public-share/${args.token}/file`,
  });
}

publicShareApp.all("/:token/file", async (c) => {
  const token = c.req.param("token");
  const resolved = await runProxyValueEffect(
    c,
    resolvePublicShareRowEffect(token),
  );
  if (resolved.kind === "response") return resolved.response;
  return forwardFileShare(c, {
    token,
    share: resolved.value,
    remainingPath: "/",
    queryString: new URL(c.req.url).search,
  });
});

publicShareApp.all("/:token/file/*", async (c) => {
  const token = c.req.param("token");
  const resolved = await runProxyValueEffect(
    c,
    resolvePublicShareRowEffect(token),
  );
  if (resolved.kind === "response") return resolved.response;
  const fullPath = new URL(c.req.url).pathname;
  const prefix = `/public-share/${token}/file`;
  const prefixIndex = fullPath.indexOf(prefix);
  const remainingPath = normalizeProxyPath(
    prefixIndex !== -1 ? fullPath.slice(prefixIndex + prefix.length) : "/",
  );
  return forwardFileShare(c, {
    token,
    share: resolved.value,
    remainingPath,
    queryString: new URL(c.req.url).search,
  });
});

publicShareApp.all("/:token/:port/*", async (c) => {
  const token = c.req.param("token");
  const port = Number(c.req.param("port"));
  const resolved = await runProxyValueEffect(
    c,
    resolvePublicShareRowEffect(token),
  );
  if (resolved.kind === "response") return resolved.response;

  const share = resolved.value;
  if (
    share.resourceType !== "preview" ||
    !Number.isInteger(port) ||
    port !== share.port ||
    PUBLIC_SHARE_BLOCKED_PORTS.has(port)
  ) {
    return c.json({ error: "Not authorized for this port" }, 403);
  }

  const fullPath = new URL(c.req.url).pathname;
  const prefix = `/public-share/${token}/${port}`;
  const prefixIndex = fullPath.indexOf(prefix);
  const remainingPath = normalizeProxyPath(
    prefixIndex !== -1 ? fullPath.slice(prefixIndex + prefix.length) : "/",
  );
  const upstreamUrl = new URL(c.req.url);
  return forwardPublicShare(c, {
    token,
    share,
    port,
    remainingPath,
    queryString: upstreamUrl.search,
    redirectPrefix: `/v1/p/public-share/${token}/${port}`,
  });
});

publicShareApp.all("/:token/:port", async (c) => {
  const token = c.req.param("token");
  const port = c.req.param("port");
  const url = new URL(c.req.url);
  return c.redirect(`/v1/p/public-share/${token}/${port}/${url.search}`, 301);
});

export { publicShareApp };
