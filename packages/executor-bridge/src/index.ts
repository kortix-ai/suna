import { createHmac, timingSafeEqual } from 'node:crypto';
import executorWorkspaceManifest from '../../../vendor/executor/package.json';
import executorSdkManifest from '../../../vendor/executor/packages/core/sdk/package.json';
import executorApiManifest from '../../../vendor/executor/packages/core/api/package.json';
import executorMcpHostManifest from '../../../vendor/executor/packages/hosts/mcp/package.json';
import executorMcpPluginManifest from '../../../vendor/executor/packages/plugins/mcp/package.json';
import executorOpenApiPluginManifest from '../../../vendor/executor/packages/plugins/openapi/package.json';
import executorGraphqlPluginManifest from '../../../vendor/executor/packages/plugins/graphql/package.json';

export type ExecutorPackageRole =
  | 'sdk'
  | 'api'
  | 'host-mcp'
  | 'plugin-mcp'
  | 'plugin-openapi'
  | 'plugin-graphql';

export interface ExecutorPackageBoundary {
  readonly role: ExecutorPackageRole;
  readonly packageName: string;
  readonly version: string;
  readonly vendorPath: string;
  readonly publicExports: readonly string[];
}

type PackageManifest = {
  readonly name: string;
  readonly version: string;
  readonly exports?: Record<string, unknown> | string;
};

const exportKeys = (manifest: PackageManifest): readonly string[] => {
  if (!manifest.exports) return [];
  if (typeof manifest.exports === 'string') return ['.'];
  return Object.keys(manifest.exports).sort();
};

const boundary = (
  role: ExecutorPackageRole,
  vendorPath: string,
  manifest: PackageManifest,
): ExecutorPackageBoundary => ({
  role,
  packageName: manifest.name,
  version: manifest.version,
  vendorPath,
  publicExports: exportKeys(manifest),
});

export const EXECUTOR_UPSTREAM = {
  name: executorWorkspaceManifest.name,
  version: executorWorkspaceManifest.version,
  repository: 'https://github.com/RhysSullivan/executor',
  vendorPath: 'vendor/executor',
} as const;

export const EXECUTOR_PACKAGE_BOUNDARIES = [
  boundary('sdk', 'vendor/executor/packages/core/sdk', executorSdkManifest),
  boundary('api', 'vendor/executor/packages/core/api', executorApiManifest),
  boundary('host-mcp', 'vendor/executor/packages/hosts/mcp', executorMcpHostManifest),
  boundary('plugin-mcp', 'vendor/executor/packages/plugins/mcp', executorMcpPluginManifest),
  boundary('plugin-openapi', 'vendor/executor/packages/plugins/openapi', executorOpenApiPluginManifest),
  boundary('plugin-graphql', 'vendor/executor/packages/plugins/graphql', executorGraphqlPluginManifest),
] as const satisfies readonly ExecutorPackageBoundary[];

export function getExecutorPackageBoundary(role: ExecutorPackageRole): ExecutorPackageBoundary {
  const match = EXECUTOR_PACKAGE_BOUNDARIES.find((entry) => entry.role === role);
  if (!match) {
    throw new Error(`Unknown Executor package boundary: ${role}`);
  }
  return match;
}

export interface ExecutorMcpSessionEnvInput {
  readonly gatewayUrl: string;
  readonly token: string;
  readonly sessionId: string;
}

export function buildExecutorMcpSessionEnv(input: ExecutorMcpSessionEnvInput): Record<string, string> {
  return {
    KORTIX_EXECUTOR_MCP_URL: input.gatewayUrl,
    KORTIX_EXECUTOR_MCP_TOKEN: input.token,
    KORTIX_EXECUTOR_MCP_SESSION_ID: input.sessionId,
  };
}

export interface ExecutorMcpSessionTokenContext {
  readonly accountId: string;
  readonly projectId: string;
  readonly sessionId: string;
  readonly userId: string;
  readonly iat: number;
  readonly exp: number;
}

export type VerifyExecutorMcpSessionTokenResult =
  | { readonly ok: true; readonly context: ExecutorMcpSessionTokenContext }
  | { readonly ok: false; readonly reason: 'malformed' | 'bad_signature' | 'expired' | 'invalid_json' };

const base64urlEncode = (value: Buffer): string => value.toString('base64url');
const base64urlDecode = (value: string): Buffer => Buffer.from(value, 'base64url');

const signPayload = (payloadB64: string, secret: string): string =>
  base64urlEncode(createHmac('sha256', secret).update(payloadB64).digest());

export function encodeExecutorMcpSessionToken(
  ctx: Omit<ExecutorMcpSessionTokenContext, 'iat' | 'exp'> & { readonly ttlSeconds?: number },
  secret: string,
): string {
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + (ctx.ttlSeconds ?? 60 * 60);
  const payload: ExecutorMcpSessionTokenContext = {
    accountId: ctx.accountId,
    projectId: ctx.projectId,
    sessionId: ctx.sessionId,
    userId: ctx.userId,
    iat,
    exp,
  };
  const payloadB64 = base64urlEncode(Buffer.from(JSON.stringify(payload), 'utf8'));
  return `${payloadB64}.${signPayload(payloadB64, secret)}`;
}

export function verifyExecutorMcpSessionToken(
  token: string | undefined | null,
  secret: string,
): VerifyExecutorMcpSessionTokenResult {
  if (!token) return { ok: false, reason: 'malformed' };
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return { ok: false, reason: 'malformed' };
  }

  const expected = signPayload(parts[0], secret);
  const actual = Buffer.from(parts[1]);
  const expectedBuffer = Buffer.from(expected);
  if (actual.length !== expectedBuffer.length || !timingSafeEqual(actual, expectedBuffer)) {
    return { ok: false, reason: 'bad_signature' };
  }

  let payload: ExecutorMcpSessionTokenContext;
  try {
    payload = JSON.parse(base64urlDecode(parts[0]).toString('utf8')) as ExecutorMcpSessionTokenContext;
  } catch {
    return { ok: false, reason: 'invalid_json' };
  }

  if (typeof payload.exp !== 'number' || payload.exp <= Math.floor(Date.now() / 1000)) {
    return { ok: false, reason: 'expired' };
  }
  if (!payload.accountId || !payload.projectId || !payload.sessionId || !payload.userId) {
    return { ok: false, reason: 'malformed' };
  }

  return { ok: true, context: payload };
}

export interface ExecutorBridgeTool {
  readonly name: string;
  readonly description?: string | null;
  readonly inputSchema?: Record<string, unknown> | null;
}

export function normalizeExecutorToolName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 192);
}

export function toMcpToolDescriptor(tool: ExecutorBridgeTool): Record<string, unknown> {
  return {
    name: tool.name,
    description: tool.description ?? '',
    inputSchema: tool.inputSchema && Object.keys(tool.inputSchema).length > 0
      ? tool.inputSchema
      : { type: 'object', additionalProperties: true },
  };
}

export function mcpTextResult(text: string, structuredContent?: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text }],
    ...(structuredContent === undefined ? {} : { structuredContent }),
  };
}
