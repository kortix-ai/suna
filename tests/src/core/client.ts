/**
 * Black-box typed HTTP client. Hits the real API over the wire (fetch), injects
 * auth per-principal, and auto-captures every request/response (redacted) into
 * the active step. Callers pass route TEMPLATES with `/v1/...` and `:param`
 * placeholders so coverage aggregation is exact and unambiguous.
 *
 *   await client.as(P.OWNER).get("/v1/projects/:id", { params: { id } }).then(r => r.status(200))
 */
import { currentRecorder } from "./context";
import { assert, BodyAssert } from "./expect";
import type { Captured } from "./result";

export type Auth =
  | { mode: "none" }
  | { mode: "bearer"; token: string }
  | { mode: "query-token"; token: string } // ?token= (preview proxy / WS)
  | { mode: "header-token"; token: string } // X-Kortix-Token
  | { mode: "cookie"; cookie: string }; // raw Cookie header

export interface Identity {
  label: string;
  auth: Auth;
}

export const ANON: Identity = { label: "ANON", auth: { mode: "none" } };

export interface ReqOpts {
  /** `:param` substitutions for the URL (template stays the coverage key). */
  params?: Record<string, string | number>;
  query?: Record<string, string | number | boolean | undefined | null>;
  /** JSON body unless `raw` is set or it's a string/FormData. */
  body?: unknown;
  headers?: Record<string, string>;
  /** Send body verbatim (no JSON.stringify, no content-type). */
  raw?: boolean;
  /** Per-request timeout (ms). */
  timeoutMs?: number;
}

const SENSITIVE_HEADERS = new Set([
  "authorization",
  "apikey",
  "cookie",
  "set-cookie",
  "x-kortix-token",
  "x-kortix-signature",
  "x-hub-signature",
  "x-hub-signature-256",
  "stripe-signature",
  "x-telegram-bot-api-secret-token",
]);

const SENSITIVE_BODY_KEYS = /(token|secret|password|api[_-]?key|push_token|private[_-]?key|access_token|refresh_token|client_secret)/i;

function mask(value: string): string {
  if (!value) return value;
  const head = value.slice(0, 6);
  return `${head}***[${value.length}]`;
}

function headersToObject(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  h.forEach((v, k) => (out[k] = v));
  return out;
}

function redactHeaders(h: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) {
    out[k] = SENSITIVE_HEADERS.has(k.toLowerCase()) ? mask(v) : v;
  }
  return out;
}

function redactJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactJson);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_BODY_KEYS.test(k) && typeof v === "string") out[k] = mask(v);
      else out[k] = redactJson(v);
    }
    return out;
  }
  return value;
}

function redactBodyText(text: string | undefined): string | undefined {
  if (!text) return text;
  try {
    return JSON.stringify(redactJson(JSON.parse(text)));
  } catch {
    // Not JSON — best-effort mask of obvious token-looking substrings.
    return text.replace(/(kortix_[a-z]*_?[A-Za-z0-9]{6,}|sk-[A-Za-z0-9]{6,}|eyJ[A-Za-z0-9_.-]{10,})/g, (m) => mask(m));
  }
}

/** Wraps a captured response with assertion sugar. */
export class Res {
  constructor(public readonly captured: Captured) {}

  get statusCode(): number {
    return this.captured.res.status;
  }

  text(): string {
    return this.captured.res.bodyText;
  }

  json<T = any>(): T {
    return this.captured.res.json as T;
  }

  header(name: string): string | undefined {
    return this.captured.res.headers[name.toLowerCase()];
  }

  /** Assert the status code (exact or set membership). */
  status(code: number | number[]): this {
    const codes = Array.isArray(code) ? code : [code];
    assert({
      kind: "status",
      description: `status in [${codes.join(", ")}]`,
      expected: codes,
      actual: this.statusCode,
      pass: codes.includes(this.statusCode),
    });
    return this;
  }

  headerEquals(name: string, expected: string | RegExp): this {
    const actual = this.header(name);
    const pass = expected instanceof RegExp ? typeof actual === "string" && expected.test(actual) : actual === expected;
    assert({
      kind: "header",
      description: `header ${name} ${expected instanceof RegExp ? "matches " + expected : "=== " + expected}`,
      expected: expected.toString(),
      actual,
      pass,
    });
    return this;
  }

  headerExists(name: string): this {
    const actual = this.header(name);
    assert({
      kind: "header.exists",
      description: `header ${name} present`,
      expected: "<present>",
      actual,
      pass: actual !== undefined,
    });
    return this;
  }

  body(): BodyAssert {
    return new BodyAssert(this.json());
  }
}

export class Client {
  private readonly origin: string;

  constructor(
    apiUrl: string,
    private readonly identity: Identity = ANON,
    private readonly defaultTimeoutMs = 60_000,
  ) {
    this.origin = new URL(apiUrl).origin;
  }

  /** Clone bound to a principal/identity. */
  as(identity: Identity): Client {
    return new Client(this.origin, identity, this.defaultTimeoutMs);
  }

  withBearer(token: string, label = "raw"): Client {
    return this.as({ label, auth: { mode: "bearer", token } });
  }

  get(t: string, o?: ReqOpts) {
    return this.request("GET", t, o);
  }
  post(t: string, body?: unknown, o?: ReqOpts) {
    return this.request("POST", t, { ...o, body });
  }
  put(t: string, body?: unknown, o?: ReqOpts) {
    return this.request("PUT", t, { ...o, body });
  }
  patch(t: string, body?: unknown, o?: ReqOpts) {
    return this.request("PATCH", t, { ...o, body });
  }
  del(t: string, o?: ReqOpts) {
    return this.request("DELETE", t, o);
  }

  private applyAuth(headers: Headers, url: URL): void {
    const a = this.identity.auth;
    switch (a.mode) {
      case "bearer":
        headers.set("authorization", `Bearer ${a.token}`);
        break;
      case "header-token":
        headers.set("x-kortix-token", a.token);
        break;
      case "cookie":
        headers.set("cookie", a.cookie);
        break;
      case "query-token":
        url.searchParams.set("token", a.token);
        break;
      case "none":
        break;
    }
  }

  async request(method: string, template: string, opts?: ReqOpts): Promise<Res> {
    let path = template;
    if (opts?.params) {
      for (const [k, v] of Object.entries(opts.params)) {
        path = path.replace(new RegExp(`:${k}(?=/|$|\\.)`, "g"), encodeURIComponent(String(v)));
      }
    }
    const url = new URL(this.origin + path);
    if (opts?.query) {
      for (const [k, v] of Object.entries(opts.query)) {
        if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
      }
    }

    const headers = new Headers();
    let bodyInit: BodyInit | undefined;
    if (opts?.body !== undefined) {
      if (opts.raw || typeof opts.body === "string") {
        bodyInit = opts.body as string;
      } else if (opts.body instanceof FormData) {
        bodyInit = opts.body;
      } else {
        headers.set("content-type", "application/json");
        bodyInit = JSON.stringify(opts.body);
      }
    }
    for (const [k, v] of Object.entries(opts?.headers ?? {})) headers.set(k, v);
    this.applyAuth(headers, url);

    const routeTemplate = `${method} ${template}`;
    const timeoutMs = opts?.timeoutMs ?? this.defaultTimeoutMs;
    const started = performance.now();

    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers,
        body: bodyInit,
        signal: AbortSignal.timeout(timeoutMs),
        redirect: "manual",
      });
    } catch (err: any) {
      // Surface as a captured "network" failure (retryable infra signal).
      const ms = performance.now() - started;
      const captured: Captured = {
        routeTemplate,
        req: { method, url: url.toString(), headers: redactHeaders(headersToObject(headers)) },
        res: { status: 0, headers: {}, bodyText: String(err?.message ?? err) },
        ms,
      };
      record(captured);
      const e = new Error(`network error ${method} ${url}: ${err?.message ?? err}`);
      (e as any).ke2eRetryable = true;
      throw e;
    }

    const bodyText = await res.text();
    const ms = performance.now() - started;
    const resHeaders: Record<string, string> = {};
    res.headers.forEach((v, k) => (resHeaders[k] = k.toLowerCase() === "set-cookie" ? mask(v) : v));
    let json: unknown;
    const ct = res.headers.get("content-type") ?? "";
    if (ct.includes("application/json")) {
      try {
        json = JSON.parse(bodyText);
      } catch {
        /* leave undefined */
      }
    }

    const captured: Captured = {
      routeTemplate,
      req: {
        method,
        url: url.toString(),
        headers: redactHeaders(headersToObject(headers)),
        body: redactBodyText(typeof bodyInit === "string" ? bodyInit : undefined),
      },
      res: { status: res.status, headers: resHeaders, bodyText: redactBodyText(bodyText) ?? "", json },
      ms,
    };
    record(captured);
    return new Res(captured);
  }
}

function record(c: Captured): void {
  const rec = currentRecorder();
  if (rec) {
    rec.pushRequest(c);
    rec.routesHit.add(c.routeTemplate);
  }
}
