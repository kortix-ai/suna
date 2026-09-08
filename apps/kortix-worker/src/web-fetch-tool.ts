import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import Turndown from "turndown";
import { Type } from "typebox";
import { Value } from "typebox/value";

const MAX_PAGE_BYTES = 5 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 128 * 1024;
const blockedV4 = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 3],
] as const)
  blockedV4.addSubnet(address, prefix, "ipv4");
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");
const blockedV6 = new BlockList();
for (const [address, prefix] of [
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
] as const)
  blockedV6.addSubnet(address, prefix, "ipv6");

export function isPublicWebAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !blockedV4.check(address, "ipv4");
  return (
    family === 6 &&
    globalV6.check(address, "ipv6") &&
    !blockedV6.check(address, "ipv6")
  );
}

interface Address {
  address: string;
  family: number;
}
interface Page {
  status: number;
  headers: Headers;
  body: Buffer;
}

export async function requestPinnedPage(
  url: URL,
  address: Address,
  signal: AbortSignal,
): Promise<Page> {
  signal.throwIfAborted();
  let stop: (() => void) | undefined;
  return new Promise<Page>((resolve, reject) => {
    let response: IncomingMessage | undefined;
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    const request = url.protocol === "https:" ? httpsRequest : httpRequest;
    const req = request(
      url,
      {
        hostname: address.address,
        family: address.family,
        ...(url.protocol === "https:" && !isIP(hostname)
          ? { servername: hostname }
          : {}),
        agent: false,
        signal,
        headers: {
          Host: url.host,
          "User-Agent": "Kortix-WebFetch/1",
          Accept:
            "text/html, text/plain, application/json, application/xml;q=0.9, */*;q=0.1",
          "Accept-Encoding": "gzip, deflate, br",
        },
      },
      async (res) => {
        response = res;
        let decoded: NodeJS.ReadableStream = res;
        try {
          const encoding = res.headers["content-encoding"]?.toLowerCase();
          if (encoding && encoding !== "identity") {
            const decompressor =
              encoding === "gzip"
                ? createGunzip()
                : encoding === "deflate"
                  ? createInflate()
                  : encoding === "br"
                    ? createBrotliDecompress()
                    : null;
            if (!decompressor)
              throw new Error("Unsupported web response encoding");
            res.on("error", (error) => decompressor.destroy(error));
            decoded = res.pipe(decompressor);
          }
          let receivedBytes = 0;
          res.on("data", (chunk: Buffer) => {
            receivedBytes += chunk.byteLength;
            if (receivedBytes > MAX_PAGE_BYTES)
              res.destroy(new Error("Web response exceeds the 5 MiB limit"));
          });
          let size = 0;
          const chunks: Buffer[] = [];
          for await (const chunk of decoded) {
            const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            size += bytes.byteLength;
            if (size > MAX_PAGE_BYTES)
              throw new Error("Web response exceeds the 5 MiB limit");
            chunks.push(bytes);
          }
          const headers = new Headers();
          for (const [name, value] of Object.entries(res.headers)) {
            if (typeof value === "string") headers.set(name, value);
            else if (Array.isArray(value))
              for (const entry of value) headers.append(name, entry);
          }
          resolve({
            status: res.statusCode ?? 0,
            headers,
            body: Buffer.concat(chunks, size),
          });
        } catch (error) {
          res.destroy();
          req.destroy();
          reject(error);
        }
      },
    );
    req.on("error", reject);
    stop = () => {
      response?.destroy();
      req.destroy();
      reject(signal.reason ?? new Error("Web fetch was aborted"));
    };
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) stop();
    else req.end();
  }).finally(() => {
    if (stop) signal.removeEventListener("abort", stop);
  });
}

function interruptible<T>(
  pending: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    pending
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}

function validateUrl(raw: string): URL {
  const url = new URL(raw);
  if (url.protocol !== "https:" && url.protocol !== "http:")
    throw new Error("webfetch requires a public HTTP or HTTPS URL");
  if (url.username || url.password)
    throw new Error("webfetch URLs must not contain credentials");
  if (
    url.hostname.toLowerCase().replace(/\.$/, "") === "localhost" ||
    url.hostname.toLowerCase().endsWith(".localhost")
  )
    throw new Error("webfetch requires a public destination");
  return url;
}

function renderPage(body: Buffer, contentType: string, format: string): string {
  const mime = contentType.split(";")[0]!.trim().toLowerCase();
  if (
    mime &&
    !mime.startsWith("text/") &&
    !/^application\/(?:json|xml|xhtml\+xml|[\w.+-]+\+(?:json|xml))$/.test(mime)
  ) {
    throw new Error(
      `webfetch does not support binary content (${mime}); download it in the environment`,
    );
  }
  const charset =
    contentType.match(/charset\s*=\s*["']?([^;\s"']+)/i)?.[1] ?? "utf-8";
  const text = new TextDecoder(charset).decode(body);
  if (
    format === "html" ||
    (mime !== "text/html" && mime !== "application/xhtml+xml")
  )
    return text;
  const renderer = new Turndown({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
  });
  if (format === "text") {
    const blocks = new Set([
      "P",
      "DIV",
      "SECTION",
      "ARTICLE",
      "H1",
      "H2",
      "H3",
      "H4",
      "H5",
      "H6",
      "LI",
      "PRE",
      "BLOCKQUOTE",
      "BR",
      "TR",
    ]);
    renderer.addRule("plain", {
      filter: () => true,
      replacement: (content, node) =>
        blocks.has(node.nodeName) ? `\n\n${content}\n\n` : content,
    });
    renderer.escape = (value) => value;
  }
  renderer.addRule("omit-active-content", {
    filter: ["head", "script", "style", "noscript"],
    replacement: () => "",
  });
  return renderer.turndown(text);
}

const parameters = Type.Object(
  {
    url: Type.String({ minLength: 1, maxLength: 8192 }),
    format: Type.Optional(
      Type.Union(
        ["text", "markdown", "html"].map((value) => Type.Literal(value)),
      ),
    ),
    timeout: Type.Optional(Type.Number({ minimum: 1, maximum: 120 })),
  },
  { additionalProperties: false },
);

export function createWebFetchTool(
  options: {
    resolve?: (hostname: string) => Promise<Address[]>;
    request?: typeof requestPinnedPage;
    authorizeRedirect?: (url: string) => void;
  } = {},
): AgentTool {
  return {
    name: "webfetch",
    label: "Fetch a web page",
    description:
      "Read a public web page as Markdown, plain text, or HTML. Supply an HTTP or HTTPS URL. Does not execute page scripts or send session credentials. Use the environment for downloads and private workspace services.",
    parameters,
    executionMode: "sequential",
    async execute(_id, input, signal) {
      if (!Value.Check(parameters, input))
        throw new TypeError("Invalid webfetch input");
      const params = input as {
        url: string;
        format?: string;
        timeout?: number;
      };
      const timeout = new AbortController();
      const timer = setTimeout(
        () => timeout.abort(new Error("Web fetch timed out")),
        (params.timeout ?? 30) * 1000,
      );
      const combined = signal
        ? AbortSignal.any([signal, timeout.signal])
        : timeout.signal;
      try {
        let url = validateUrl(params.url);
        const format = params.format ?? "markdown";
        for (let hop = 0; hop <= 5; hop++) {
          combined.throwIfAborted();
          const hostname = url.hostname.replace(/^\[|\]$/g, "");
          const family = isIP(hostname);
          const addresses = family
            ? [{ address: hostname, family }]
            : await interruptible(
                (options.resolve ?? ((name) => lookup(name, { all: true })))(
                  hostname,
                ),
                combined,
              );
          if (
            !addresses.length ||
            addresses.some((address) => !isPublicWebAddress(address.address))
          )
            throw new Error("webfetch requires a public destination");
          const address =
            addresses.find((value) => value.family === 4) ?? addresses[0]!;
          const page = await (options.request ?? requestPinnedPage)(
            url,
            address,
            combined,
          );
          if ([301, 302, 303, 307, 308].includes(page.status)) {
            const location = page.headers.get("location");
            if (!location) throw new Error("Web redirect has no destination");
            url = validateUrl(new URL(location, url).href);
            options.authorizeRedirect?.(url.href);
            continue;
          }
          if (page.status < 200 || page.status >= 300)
            throw new Error(`Web page returned HTTP ${page.status}`);
          const contentType = page.headers.get("content-type") ?? "text/plain";
          const output = Buffer.from(
            renderPage(page.body, contentType, format),
          );
          const truncated = output.byteLength > MAX_OUTPUT_BYTES;
          const text = output.subarray(0, MAX_OUTPUT_BYTES).toString("utf8");
          return {
            content: [{ type: "text", text }],
            details: { url: url.href, format, contentType, truncated },
          };
        }
        throw new Error("Web fetch exceeded 5 redirects");
      } catch (error) {
        combined.throwIfAborted();
        throw error;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
