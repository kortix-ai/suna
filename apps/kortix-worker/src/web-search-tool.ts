import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { Value } from "typebox/value";

const parameters = Type.Object({
  query: Type.String({ minLength: 1, maxLength: 4000 }),
  numResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
  type: Type.Optional(
    Type.Union(["auto", "fast", "deep"].map((value) => Type.Literal(value))),
  ),
  livecrawl: Type.Optional(
    Type.Union(["fallback", "preferred"].map((value) => Type.Literal(value))),
  ),
  contextMaxCharacters: Type.Optional(
    Type.Integer({ minimum: 1, maximum: 50000 }),
  ),
});
const responseLimit = 256 * 1024;

function searchText(value: unknown): string {
  if (!value || typeof value !== "object")
    throw new Error("Invalid search provider response");
  const envelope = value as {
    jsonrpc?: string;
    id?: unknown;
    error?: unknown;
    result?: { isError?: boolean; content?: unknown };
  };
  if (envelope.jsonrpc !== "2.0" || envelope.id !== 1)
    throw new Error("Invalid search provider response identity");
  if (envelope.error || envelope.result?.isError)
    throw new Error("The search provider could not complete this query");
  if (!Array.isArray(envelope.result?.content))
    throw new Error("Invalid search provider response content");
  const texts = envelope.result.content.flatMap((part: unknown) => {
    if (!part || typeof part !== "object")
      throw new Error("Invalid search provider response block");
    const block = part as { type?: unknown; text?: unknown };
    if (block.type !== "text") return [];
    if (typeof block.text !== "string")
      throw new Error("Invalid search provider response text");
    return [block.text];
  });
  return texts.join("\n\n") || "No search results found.";
}

async function readSearchResponse(response: Response): Promise<string> {
  if (!response.body) throw new Error("Missing search provider response body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const isStream = response.headers
    .get("content-type")
    ?.includes("text/event-stream");
  let pending = "";
  let size = 0;
  const frame = (event: string): string | undefined => {
    const data = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n");
    if (!data || data === "[DONE]") return undefined;
    const value = JSON.parse(data) as { id?: unknown; method?: unknown };
    if (value && value.id === undefined && typeof value.method === "string")
      return undefined;
    return searchText(value);
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > responseLimit)
        throw new Error("Search provider response exceeds the 256 KiB limit");
      pending += decoder.decode(value, { stream: true });
      if (!isStream) continue;
      let boundary: RegExpExecArray | null;
      while ((boundary = /\r?\n\r?\n/.exec(pending))) {
        const event = pending.slice(0, boundary.index);
        pending = pending.slice(boundary.index + boundary[0].length);
        const result = frame(event);
        if (result !== undefined) return result;
      }
    }
    pending += decoder.decode();
    if (!isStream) return searchText(JSON.parse(pending));
    const result = frame(pending);
    if (result !== undefined) return result;
    throw new Error("Search provider response ended without a result");
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function createWebSearchTool(
  options: { fetch?: typeof fetch; timeoutMs?: number } = {},
): AgentTool {
  const request = options.fetch ?? globalThis.fetch;
  return {
    name: "websearch",
    label: "Search the web",
    description:
      "Search the web for current information and sources. Returns titles, URLs, and excerpts. Use specific queries and cite the returned source URLs.",
    parameters,
    executionMode: "sequential",
    async execute(_id, input, signal) {
      signal?.throwIfAborted();
      if (!Value.Check(parameters, input))
        throw new TypeError("Invalid websearch input");
      const params = input as {
        query: string;
        numResults?: number;
        type?: string;
        livecrawl?: string;
        contextMaxCharacters?: number;
      };
      if (!params.query.trim())
        throw new TypeError("websearch query cannot be blank");
      const timeout = new AbortController();
      const timer = setTimeout(
        () => timeout.abort(new Error("Web search timed out")),
        options.timeoutMs ?? 25000,
      );
      const combined = signal
        ? AbortSignal.any([signal, timeout.signal])
        : timeout.signal;
      try {
        const response = await request("https://mcp.exa.ai/mcp", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: {
              name: "web_search_exa",
              arguments: {
                query: params.query,
                numResults: params.numResults ?? 8,
                type: params.type ?? "auto",
                livecrawl: params.livecrawl ?? "fallback",
                contextMaxCharacters: params.contextMaxCharacters ?? 10000,
              },
            },
          }),
          redirect: "error",
          signal: combined,
        });
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error(`Search provider returned HTTP ${response.status}`);
        }
        const text = await readSearchResponse(response);
        return {
          content: [{ type: "text", text }],
          details: { query: params.query, provider: "exa" },
        };
      } catch (error) {
        combined.throwIfAborted();
        throw error;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
