import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { createScopedKortix } from "../../../packages/sdk/src/node/server";

const searchInput = Type.Object(
  {
    query: Type.String({ maxLength: 1024 }),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
  },
  { additionalProperties: false },
);
const describeInput = Type.Object(
  { tool: Type.String({ minLength: 3, maxLength: 512 }) },
  { additionalProperties: false },
);
const callInput = Type.Object(
  {
    tool: Type.String({ minLength: 3, maxLength: 512 }),
    args: Type.Record(Type.String(), Type.Unknown()),
  },
  { additionalProperties: false },
);
const imageTypes = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);
const MAX_TEXT_BYTES = 512 * 1024;

function textResult(value: unknown) {
  const text = JSON.stringify(value ?? null);
  if (Buffer.byteLength(text) > MAX_TEXT_BYTES)
    throw new Error("Connector result exceeds 512 KiB of text");
  return [{ type: "text" as const, text }];
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function connectorContent(data: unknown): (TextContent | ImageContent)[] {
  if (record(data) && data.jsonrpc === "2.0") {
    if ("error" in data) {
      const message = record(data.error) && typeof data.error.message === "string"
        ? data.error.message.slice(0, 4096)
        : "Remote MCP request failed";
      throw new Error(message);
    }
    if (!record(data.result)) {
      throw new Error("Unsupported or malformed MCP result");
    }
    const result = data.result;
    if (Array.isArray(result.content)) {
      data = result;
    } else if (result.isError) {
      throw new Error("Remote MCP request failed");
    } else if (Array.isArray(result.contents)) {
      data = { content: result.contents.map(resource => ({ type: "resource", resource })) };
    } else if (Array.isArray(result.messages)) {
      const content: unknown[] = [];
      if (typeof result.description === "string") content.push({ type: "text", text: result.description });
      for (const message of result.messages) {
        if (!record(message) || !["user", "assistant"].includes(String(message.role)) || !record(message.content)) {
          throw new Error("Unsupported or malformed MCP prompt message");
        }
        content.push(...textResult({ source: "remote_mcp_prompt", role: message.role }), message.content);
      }
      data = { content };
    } else if (["resources", "resourceTemplates", "prompts"].some(key => Array.isArray(result[key]))) {
      return textResult(result);
    } else {
      throw new Error("Unsupported or malformed MCP result");
    }
  }
  if (!record(data) || !Array.isArray(data.content)) return textResult(data);
  const result = data as {
    content: unknown[];
    structuredContent?: unknown;
    isError?: boolean;
  };
  if (result.isError) {
    throw new Error(
      result.content
        .flatMap((block) =>
          record(block) &&
          block.type === "text" &&
          typeof block.text === "string"
            ? [block.text]
            : [],
        )
        .join("\n")
        .slice(0, 4096) || "Remote MCP tool failed",
    );
  }
  const content = result.content.flatMap<TextContent | ImageContent>(
    (block): (TextContent | ImageContent)[] => {
      if (!record(block))
        throw new Error("Unsupported or malformed MCP content");
      if (block.type === "text" && typeof block.text === "string")
        return [{ type: "text", text: block.text }];
      if (
        block.type === "image" &&
        typeof block.mimeType === "string" &&
        imageTypes.has(block.mimeType) &&
        typeof block.data === "string"
      ) {
        return [{ type: "image", mimeType: block.mimeType, data: block.data }];
      }
      if (
        block.type === "resource_link" &&
        typeof block.uri === "string" &&
        typeof block.name === "string"
      )
        return textResult(block);
      if (
        block.type === "resource" &&
        record(block.resource) &&
        typeof block.resource.uri === "string" &&
        typeof block.resource.mimeType === "string" &&
        imageTypes.has(block.resource.mimeType) &&
        typeof block.resource.blob === "string" &&
        !("text" in block.resource)
      ) {
        return [
          ...textResult({ type: "resource", resource: { uri: block.resource.uri, mimeType: block.resource.mimeType } }),
          { type: "image", mimeType: block.resource.mimeType, data: block.resource.blob },
        ];
      }
      if (
        block.type === "resource" &&
        record(block.resource) &&
        typeof block.resource.text === "string" &&
        typeof block.resource.uri === "string" &&
        !("blob" in block.resource)
      )
        return textResult(block);
      throw new Error("Unsupported or malformed MCP content");
    },
  );
  if (result.structuredContent !== undefined)
    content.push(...textResult(result.structuredContent));
  if (
    content.reduce(
      (size, block) =>
        size + (block.type === "text" ? Buffer.byteLength(block.text) : 0),
      0,
    ) > MAX_TEXT_BYTES
  ) {
    throw new Error("Connector result exceeds 512 KiB of text");
  }
  return content.length ? content : textResult({ ok: true });
}

export function createConnectorTools(options: {
  apiUrl: string;
  projectId: string;
  token: string;
}): AgentTool[] {
  let urlEnd = options.apiUrl.length;
  while (urlEnd > 0 && options.apiUrl[urlEnd - 1] === "/") urlEnd--;
  const client = createScopedKortix({
    backendUrl: options.apiUrl.slice(0, urlEnd),
    getToken: async () => options.token,
    clientSource: "api",
  });
  const connectors = client.project(options.projectId).connectors;
  return [
    {
      name: "connector_search",
      label: "Find connector tools",
      description:
        "Find authorized tools from the project connectors, including remote MCP servers. Does not start the execution environment. Use connector_describe to inspect the input schema.",
      parameters: searchInput,
      executionMode: "sequential",
      async execute(_id, input, signal) {
        signal?.throwIfAborted();
        if (!Value.Check(searchInput, input))
          throw new Error(
            "Connector search requires a query and an optional limit from 1 to 20",
          );
        const found = await connectors.search(input.query, {
          limit: input.limit ?? 12,
          signal,
        });
        return {
          content: textResult(
            found.map(({ tool, description, risk }) => ({
              tool,
              description,
              risk,
            })),
          ),
          details: { count: found.length },
        };
      },
    },
    {
      name: "connector_describe",
      label: "Describe connector tool",
      description:
        "Read the input schema, description, and risk for an authorized connector.action tool.",
      parameters: describeInput,
      executionMode: "sequential",
      async execute(_id, input, signal) {
        signal?.throwIfAborted();
        if (!Value.Check(describeInput, input))
          throw new Error("Connector description requires a tool identifier");
        const tool = await connectors.describe(input.tool, { signal });
        if (!tool)
          throw new Error("Connector tool is not available to this agent");
        return { content: textResult(tool), details: { tool: input.tool } };
      },
    },
    {
      name: "connector_call",
      label: "Call connector tool",
      description:
        "Call an authorized connector.action with arguments matching its schema. The server enforces connector grants and action policy. If approval is pending, show the returned approval link and wait; do not repeat the call or poll for approval.",
      parameters: callInput,
      executionMode: "sequential",
      async execute(_id, input, signal) {
        signal?.throwIfAborted();
        if (!Value.Check(callInput, input))
          throw new Error(
            "Connector call requires a tool identifier and an args object",
          );
        const result = await connectors.call(input.tool, input.args, {
          signal,
        });
        signal?.throwIfAborted();
        return {
          content: result.ok
            ? connectorContent(result.data)
            : textResult(result),
          details: {
            tool: input.tool,
            status: result.status ?? (result.ok ? "completed" : "error"),
          },
        };
      },
    },
  ];
}
