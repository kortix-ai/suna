/**
 * Shared Zod schemas for OpenAPI documentation.
 * Used across all route files with describeRoute() + resolver().
 */
import { z } from 'zod'

// ─── Common response schemas ────────────────────────────────────────────────

export const ErrorResponse = z.object({
  error: z.string().describe('Error message'),
  details: z.string().optional().describe('Additional error details'),
})

export const SuccessResponse = z.object({
  ok: z.literal(true),
})

export const UnauthorizedResponse = z.object({
  error: z.literal('Unauthorized'),
})

// ─── ENV schemas ────────────────────────────────────────────────────────────

export const SecretEntry = z.object({
  key: z.string(),
  value: z.string(),
})

export const SecretsListResponse = z.object({
  secrets: z.record(z.string(), z.string()).describe('Key-value map of all secrets'),
})

export const SetBulkEnvBody = z.object({
  keys: z.record(z.string(), z.string()).describe('Key-value map of env vars to set'),
  restart: z.boolean().optional().describe('Restart OpenCode after setting (default: false)'),
})

export const SetBulkEnvResponse = z.object({
  ok: z.literal(true),
  updated: z.number().int().describe('Number of keys updated'),
  restarted: z.boolean().describe('Whether services were restarted'),
})

export const SetSingleEnvBody = z.object({
  value: z.string().describe('Value to set for the key'),
  restart: z.boolean().optional().describe('Restart OpenCode after setting (default: false)'),
})

export const SetSingleEnvResponse = z.object({
  ok: z.literal(true),
  key: z.string(),
  restarted: z.boolean(),
})

export const DeleteEnvResponse = z.object({
  ok: z.literal(true),
  key: z.string(),
})

export const RotateTokenBody = z.object({
  token: z.string().describe('New KORTIX_TOKEN value'),
})

export const RotateTokenResponse = z.object({
  ok: z.literal(true),
  rotated: z.number().int().describe('Number of secrets re-encrypted'),
})

// ─── File schemas ───────────────────────────────────────────────────────────

export const FileNode = z.object({
  name: z.string(),
  path: z.string(),
  absolute: z.string(),
  type: z.enum(['file', 'directory']),
  ignored: z.boolean(),
})

export const FileContentTextResponse = z.object({
  type: z.literal('text'),
  content: z.string(),
})

export const FileContentBinaryResponse = z.object({
  type: z.literal('binary'),
  content: z.string().describe('Base64-encoded file content'),
  mimeType: z.string(),
  encoding: z.literal('base64'),
})

export const UploadResult = z.object({
  path: z.string(),
  size: z.number().int(),
})

export const DeleteFileBody = z.object({
  path: z.string().describe('Absolute or workspace-relative path'),
})

export const MkdirBody = z.object({
  path: z.string().describe('Directory path to create'),
})

export const RenameBody = z.object({
  from: z.string().describe('Source path'),
  to: z.string().describe('Target path'),
})

// ─── LSS schemas ────────────────────────────────────────────────────────────

export const LssHit = z.object({
  file_path: z.string(),
  score: z.number(),
  snippet: z.string(),
  rank_stage: z.string(),
  indexed_at: z.string().optional(),
})

export const LssSearchResult = z.object({
  query: z.string(),
  hits: z.array(LssHit),
})

export const LssStatusResponse = z.object({
  available: z.boolean(),
  output: z.string(),
})

// ─── Deploy schemas ─────────────────────────────────────────────────────────

export const DeployBody = z.object({
  deploymentId: z.string().describe('Unique deployment identifier'),
  sourceType: z.enum(['files', 'git']).optional().describe('Source type (default: files)'),
  sourceRef: z.string().optional().describe('Git ref or branch'),
  sourcePath: z.string().optional().describe('Source path (default: /workspace)'),
  framework: z.string().optional().describe('Framework hint (auto-detected if omitted)'),
  envVarKeys: z.array(z.string()).optional().describe('Env var keys to inject'),
  buildConfig: z.object({
    buildCommand: z.string().optional(),
    outputDir: z.string().optional(),
  }).optional().describe('Custom build configuration'),
  entrypoint: z.string().optional().describe('Custom entrypoint file'),
})

export const DeployResponse = z.object({
  success: z.boolean(),
  port: z.number().int().optional(),
  pid: z.number().int().optional(),
  framework: z.string().optional(),
  error: z.string().optional(),
  logs: z.array(z.string()).optional(),
  buildDuration: z.number().optional(),
  startDuration: z.number().optional(),
})

export const DeploymentStatus = z.object({
  status: z.enum(['running', 'stopped', 'not_found']),
  port: z.number().int().optional(),
  pid: z.number().int().optional(),
  framework: z.string().optional(),
  startedAt: z.string().optional(),
  error: z.string().optional(),
})

export const DeploymentListItem = z.object({
  id: z.string(),
  status: z.string(),
  port: z.number().int().optional(),
  pid: z.number().int().optional(),
  framework: z.string().optional(),
  startedAt: z.string().optional(),
})

export const DeploymentListResponse = z.object({
  deployments: z.array(DeploymentListItem),
})

export const DeploymentLogsResponse = z.object({
  logs: z.array(z.string()),
  error: z.string().optional(),
})

// ─── Update schemas ─────────────────────────────────────────────────────────

export const UpdateBody = z.object({
  version: z.string().describe('Target version to install (e.g. "0.4.3")'),
})

export const UpdateResponse = z.object({
  success: z.boolean().optional(),
  upToDate: z.boolean().optional(),
  previousVersion: z.string().optional(),
  currentVersion: z.string(),
  output: z.string().optional(),
})

export const UpdateStatusResponse = z.object({
  inProgress: z.boolean().describe('Whether an update is currently running'),
  phase: z.enum([
    'idle',
    'staging',
    'verifying',
    'committing',
    'restarting',
    'validating',
    'rolling_back',
    'complete',
    'failed',
  ]).describe('Current update phase'),
  message: z.string().describe('Human-readable status message'),
  targetVersion: z.string().nullable().describe('Target version being installed'),
  previousVersion: z.string().nullable().describe('Version before update started'),
  currentVersion: z.string().describe('Version currently reported by /ephemeral/metadata/.version'),
  startedAt: z.string().nullable().describe('ISO timestamp when the update started'),
  updatedAt: z.string().nullable().describe('ISO timestamp when status was last updated'),
  error: z.string().nullable().describe('Failure details when phase is failed'),
})

// ─── Integration schemas ────────────────────────────────────────────────────

export const IntegrationTokenBody = z.object({
  app: z.string().describe('Integration app slug'),
  scopes: z.array(z.string()).optional(),
})

export const IntegrationProxyBody = z.object({
  app: z.string().describe('Integration app slug'),
  url: z.string().describe('Target API URL'),
  method: z.string().optional().describe('HTTP method (default: GET)'),
  headers: z.record(z.string(), z.string()).optional(),
  body: z.any().optional(),
})

export const IntegrationConnectBody = z.object({
  app: z.string().describe('Integration app slug'),
})

export const IntegrationRunActionBody = z.object({
  app: z.string().describe('Integration app slug'),
  action_key: z.string().describe('Action key from actions list'),
  props: z.record(z.string(), z.any()).optional().describe('Action parameters'),
})

// ─── Health schemas ─────────────────────────────────────────────────────────

export const HealthResponse = z.object({
  status: z.enum(['ok', 'starting']).describe("'ok' when the agent runtime is reachable, 'starting' otherwise"),
  version: z.string().describe('Current sandbox version'),
  imageVersion: z.string().describe('Version baked into the Docker image'),
  activeWs: z.number().int().describe('Active WebSocket connections'),
  runtimeReady: z.boolean().describe('Whether the agent runtime is ready'),
  opencodeStorageBase: z.string().nullable().describe('Configured OpenCode storage base path'),
  persistentRoot: z.string().nullable().describe('Configured persistent root path'),
  persistentMode: z.boolean().describe('True when OpenCode is using the canonical /persistent storage path'),
  opencodeLegacyLinked: z.boolean().describe('True when /workspace/.local/share/opencode is linked to the canonical persistent path'),
  opencodeStateGuardAvailable: z.boolean().describe('True when kortix-opencode-state is installed in the runtime'),
  opencodeSessionCount: z.number().int().nullable().describe('Live OpenCode session count from the active DB'),
  opencodeShadowSessionCount: z.number().int().nullable().describe('Shadow OpenCode session count from preserved state'),
  opencodeStateMismatch: z.boolean().describe('True when preserved shadow state is richer than the active live DB'),
})

export const PortsResponse = z.object({
  ports: z.record(z.string(), z.string()).describe('Container→host port mappings'),
})

// ─── Proxy schemas ──────────────────────────────────────────────────────────

export const ProxyErrorResponse = z.object({
  error: z.string(),
  port: z.number().int(),
  hint: z.string().optional(),
  details: z.string().optional(),
})
