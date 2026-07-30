import { MCP_PROTOCOL_VERSION, MCP_SERVER_VERSION } from '@/lib/agent-discovery';
import {
  getPublicContentRecords,
  resolvePublicMarkdown,
  type PublicContentKind,
} from '@/lib/seo/public-content';

type JsonRpcId = string | number | null;
type JsonRpcRequest = {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: Record<string, unknown>;
};

const TOOL_DEFINITIONS = [
  {
    name: 'list_public_content',
    description: 'List Kortix public documentation and marketing pages.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          enum: ['marketing', 'blog', 'docs', 'use-case'],
          description: 'Optional content category.',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 50,
          default: 25,
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_public_markdown',
    description: 'Read the Markdown representation of a Kortix public page.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Canonical path returned by list_public_content, such as /docs or /pricing.',
        },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
] as const;

function result(id: JsonRpcId, value: unknown) {
  return { jsonrpc: '2.0', id, result: value };
}

function error(id: JsonRpcId, code: number, message: string, data?: unknown) {
  return {
    jsonrpc: '2.0',
    id,
    error: { code, message, ...(data === undefined ? {} : { data }) },
  };
}

function publicRecordData(kind?: PublicContentKind, limit = 25) {
  return getPublicContentRecords()
    .filter((record) => !kind || record.kind === kind)
    .filter((record) => record.markdownPath)
    .slice(0, Math.min(Math.max(limit, 1), 50))
    .map((record) => ({
      kind: record.kind,
      title: record.title,
      description: record.description ?? null,
      path: record.htmlPath,
      markdown_path: record.markdownPath,
    }));
}

function resolveMarkdownFromHtmlPath(htmlPath: string) {
  const record = getPublicContentRecords().find(
    (candidate) => candidate.htmlPath === htmlPath && candidate.markdownPath,
  );
  if (!record?.markdownPath) return null;
  const segments = record.markdownPath.replace(/^\/markdown\//, '').split('/');
  return resolvePublicMarkdown(segments);
}

function toolText(text: string, structuredContent?: unknown) {
  return {
    content: [{ type: 'text', text }],
    ...(structuredContent === undefined ? {} : { structuredContent }),
  };
}

function callTool(name: unknown, args: unknown) {
  const input = args && typeof args === 'object' ? (args as Record<string, unknown>) : {};
  if (name === 'list_public_content') {
    const kind = typeof input.kind === 'string' ? (input.kind as PublicContentKind) : undefined;
    if (kind && !['marketing', 'blog', 'docs', 'use-case'].includes(kind)) {
      return { isError: true, ...toolText(`Unsupported kind: ${kind}`) };
    }
    const requestedLimit = typeof input.limit === 'number' ? input.limit : 25;
    if (!Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 50) {
      return { isError: true, ...toolText('limit must be an integer from 1 through 50') };
    }
    const records = publicRecordData(kind, requestedLimit);
    return toolText(JSON.stringify(records, null, 2), { records });
  }

  if (name === 'get_public_markdown') {
    const path = typeof input.path === 'string' ? input.path : '';
    if (!path.startsWith('/') || path.startsWith('//') || path.includes('://')) {
      return { isError: true, ...toolText('path must be an absolute Kortix path') };
    }
    const resolved = resolveMarkdownFromHtmlPath(path);
    if (!resolved) return { isError: true, ...toolText(`No public Markdown exists for ${path}`) };
    return toolText(resolved.markdown, {
      path: resolved.record.htmlPath,
      title: resolved.record.title,
    });
  }

  return { isError: true, ...toolText(`Unknown tool: ${String(name)}`) };
}

export function handlePublicContentMcp(request: JsonRpcRequest) {
  const id = request.id ?? null;
  if (request.jsonrpc !== '2.0' || typeof request.method !== 'string') {
    return error(id, -32600, 'Invalid Request');
  }

  switch (request.method) {
    case 'initialize':
      return result(id, {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {
          tools: { listChanged: false },
          resources: { subscribe: false, listChanged: false },
        },
        serverInfo: {
          name: 'kortix-public-content',
          version: MCP_SERVER_VERSION,
        },
        instructions: 'Use list_public_content before get_public_markdown.',
      });
    case 'ping':
      return result(id, {});
    case 'tools/list':
      return result(id, { tools: TOOL_DEFINITIONS });
    case 'tools/call':
      return result(id, callTool(request.params?.name, request.params?.arguments));
    case 'resources/list': {
      const resources = publicRecordData(undefined, 50).map((record) => ({
        uri: `https://kortix.com${record.markdown_path}`,
        name: record.title,
        description: record.description ?? undefined,
        mimeType: 'text/markdown',
      }));
      return result(id, { resources });
    }
    case 'resources/read': {
      const uri = request.params?.uri;
      if (typeof uri !== 'string') return error(id, -32602, 'uri is required');
      let pathname = '';
      try {
        const url = new URL(uri);
        if (url.origin !== 'https://kortix.com')
          return error(id, -32602, 'uri must use kortix.com');
        pathname = url.pathname;
      } catch {
        return error(id, -32602, 'uri must be an absolute URL');
      }
      const record = getPublicContentRecords().find(
        (candidate) => candidate.markdownPath === pathname,
      );
      if (!record?.markdownPath) return error(id, -32602, 'resource was not found');
      const resolved = resolvePublicMarkdown(
        record.markdownPath.replace(/^\/markdown\//, '').split('/'),
      );
      if (!resolved) return error(id, -32603, 'resource could not be rendered');
      return result(id, {
        contents: [{ uri, mimeType: 'text/markdown', text: resolved.markdown }],
      });
    }
    case 'notifications/initialized':
      return null;
    default:
      return error(id, -32601, 'Method not found');
  }
}
