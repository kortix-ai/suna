import { createRoute, z } from '@hono/zod-openapi'
import { and, desc, eq, inArray, ne, sql } from 'drizzle-orm'
import { computeNodeAssignments, computeNodeDeviceAuthRequests, computeNodeEnrollmentTokens, computeNodes, projects, projectSessions } from '@kortix/db'
import type { NodeAssignmentSpec } from '@kortix/api-contract/node-channel'
import { ACCOUNT_ACTIONS, assertAuthorized } from '../../iam'
import { actorOf } from '../../iam/actor'
import { auth, errors, json } from '../../openapi'
import { db } from '../../shared/db'
import { loadProjectForUser } from '../../projects/lib/access'
import {
  createNodeEnrollmentToken,
  revokeNodeCredentials,
} from '../../repositories/compute-node-credentials'
import { assignComputeNode, computeNodeChannel, stopComputeNodeAssignment } from '../../compute-nodes'
import { nodeRelayIsLive } from '../../compute-nodes/cluster-forwarder'
import { createAccountToken } from '../../repositories/account-tokens'
import { deriveKortixApiBase, proxyGitUrl } from '../../projects/lib/sessions'
import { encryptEnrollment } from '../../compute-nodes/device-auth'
import { generateNodeEnrollmentToken, hashSecretKey } from '../../shared/crypto'
import { accountsRouter } from './app'

const NodeType = z.enum(['sandbox', 'workstation', 'vm', 'container', 'bare_metal', 'ci'])
const NodeSchema = z.object({
  compute_node_id: z.string(),
  account_id: z.string(),
  project_id: z.string().nullable(),
  type: z.string(),
  provider: z.string().nullable(),
  allocation_id: z.string().nullable(),
  architecture: z.string().nullable(),
  operating_system: z.string().nullable(),
  daemon_version: z.string().nullable(),
  update_channel: z.string(),
  status: z.string(),
  capabilities: z.array(z.string()),
  harnesses: z.array(z.any()),
  concurrency: z.number(),
  connected: z.boolean(),
  last_heartbeat_at: z.string().nullable(),
  desired_manifest: z.record(z.string(), z.any()),
  metadata: z.record(z.string(), z.any()),
  created_at: z.string(),
  updated_at: z.string(),
})
const AssignmentSchema = z.object({
  assignment_id: z.string(), node_id: z.string(), account_id: z.string(), project_id: z.string(),
  session_id: z.string(), status: z.string(), lease_epoch: z.number(), lease_expires_at: z.string().nullable(),
  metadata: z.record(z.string(), z.any()), created_at: z.string(), updated_at: z.string(),
})

function serializeNode(row: typeof computeNodes.$inferSelect) {
  return {
    compute_node_id: row.nodeId,
    account_id: row.accountId,
    project_id: row.projectId,
    type: row.type,
    provider: row.provider,
    allocation_id: row.allocationId,
    architecture: row.architecture,
    operating_system: row.operatingSystem,
    daemon_version: row.daemonVersion,
    update_channel: row.updateChannel,
    status: row.status,
    capabilities: row.capabilities,
    harnesses: row.harnesses,
    concurrency: row.concurrency,
    connected: computeNodeChannel.isConnected(row.nodeId) || nodeRelayIsLive(row),
    last_heartbeat_at: row.lastHeartbeatAt?.toISOString() ?? null,
    desired_manifest: row.desiredManifest,
    metadata: row.metadata,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  }
}

async function loadAccountNode(accountId: string, nodeId: string) {
  const [row] = await db
    .select()
    .from(computeNodes)
    .where(and(eq(computeNodes.nodeId, nodeId), eq(computeNodes.accountId, accountId), ne(computeNodes.status, 'deleted')))
    .limit(1)
  return row ?? null
}

async function authorizeProject(c: any, accountId: string, projectId: string | null | undefined, action: 'read' | 'manage') {
  if (!projectId) return true
  const loaded = await loadProjectForUser(c, projectId, action)
  return Boolean(loaded && loaded.row.accountId === accountId)
}

function serializeAssignment(row: typeof computeNodeAssignments.$inferSelect) {
  return {
    assignment_id: row.assignmentId, node_id: row.nodeId, account_id: row.accountId,
    project_id: row.projectId, session_id: row.sessionId, status: row.status,
    lease_epoch: row.leaseEpoch, lease_expires_at: row.leaseExpiresAt?.toISOString() ?? null,
    metadata: row.metadata, created_at: row.createdAt.toISOString(), updated_at: row.updatedAt.toISOString(),
  }
}

export function registerComputeNodeRoutes(): void {
  accountsRouter.openapi(
    createRoute({ method: 'get', path: '/{accountId}/compute-nodes/device-auth/{code}', tags: ['compute-nodes'], summary: 'Read a pending node enrollment challenge', ...auth, request: { params: z.object({ accountId: z.string(), code: z.string() }) }, responses: { 200: json(z.object({ device_code: z.string(), machine_hostname: z.string(), type: z.string(), expires_at: z.string() }), 'Pending device challenge'), ...errors(401, 403, 404) } }),
    async (c: any) => {
      const accountId = c.req.param('accountId')
      await assertAuthorized(await actorOf(c, accountId), ACCOUNT_ACTIONS.TOKEN_CREATE)
      const [row] = await db.select().from(computeNodeDeviceAuthRequests).where(and(eq(computeNodeDeviceAuthRequests.deviceCode, c.req.param('code')), eq(computeNodeDeviceAuthRequests.status, 'pending'))).limit(1)
      if (!row || row.expiresAt <= new Date()) return c.json({ error: 'Device authorization request not found or expired' }, 404)
      return c.json({ device_code: row.deviceCode, machine_hostname: row.machineHostname, type: row.nodeType, expires_at: row.expiresAt.toISOString() })
    },
  )

  accountsRouter.openapi(
    createRoute({ method: 'post', path: '/{accountId}/compute-nodes/device-auth/{code}/approve', tags: ['compute-nodes'], summary: 'Approve and register a compute node', ...auth, request: { params: z.object({ accountId: z.string(), code: z.string() }), body: { content: { 'application/json': { schema: z.object({ project_id: z.string().uuid().nullable().optional(), update_channel: z.string().default('stable'), concurrency: z.number().int().min(1).max(1024).default(1) }) } } } }, responses: { 201: json(NodeSchema, 'Registered compute node'), ...errors(400, 401, 403, 404, 409) } }),
    async (c: any) => {
      const accountId = c.req.param('accountId')
      await assertAuthorized(await actorOf(c, accountId), ACCOUNT_ACTIONS.TOKEN_CREATE)
      const body = await c.req.json()
      if (!(await authorizeProject(c, accountId, body.project_id, 'manage'))) return c.json({ error: 'Project not found' }, 404)
      const token = generateNodeEnrollmentToken()
      const result = await db.transaction(async (tx) => {
        const [request] = await tx.update(computeNodeDeviceAuthRequests).set({ status: 'approved', accountId, resolvedAt: new Date() }).where(and(eq(computeNodeDeviceAuthRequests.deviceCode, c.req.param('code')), eq(computeNodeDeviceAuthRequests.status, 'pending'), sql`${computeNodeDeviceAuthRequests.expiresAt} > now()`)).returning()
        if (!request) return null
        const [node] = await tx.insert(computeNodes).values({ accountId, projectId: body.project_id ?? null, type: request.nodeType, updateChannel: body.update_channel ?? 'stable', concurrency: body.concurrency ?? 1, status: 'offline', metadata: { machineHostname: request.machineHostname, enrollment: 'device-auth' } }).returning()
        if (!node) return null
        await tx.insert(computeNodeEnrollmentTokens).values({ nodeId: node.nodeId, accountId, secretHash: hashSecretKey(token), expiresAt: new Date(Math.min(request.expiresAt.getTime(), Date.now() + 10 * 60_000)), createdBy: c.get('userId') })
        await tx.update(computeNodeDeviceAuthRequests).set({ nodeId: node.nodeId, encryptedEnrollment: encryptEnrollment(token, request.secretHash) }).where(eq(computeNodeDeviceAuthRequests.requestId, request.requestId))
        return node
      })
      if (!result) return c.json({ error: 'Device authorization request not found, expired, or resolved' }, 409)
      return c.json(serializeNode(result), 201)
    },
  )

  accountsRouter.openapi(
    createRoute({ method: 'post', path: '/{accountId}/compute-nodes/device-auth/{code}/deny', tags: ['compute-nodes'], summary: 'Deny a compute-node enrollment challenge', ...auth, request: { params: z.object({ accountId: z.string(), code: z.string() }) }, responses: { 200: json(z.object({ ok: z.boolean() }), 'Denied'), ...errors(401, 403, 404) } }),
    async (c: any) => {
      const accountId = c.req.param('accountId')
      await assertAuthorized(await actorOf(c, accountId), ACCOUNT_ACTIONS.TOKEN_CREATE)
      const [row] = await db.update(computeNodeDeviceAuthRequests).set({ status: 'denied', accountId, resolvedAt: new Date() }).where(and(eq(computeNodeDeviceAuthRequests.deviceCode, c.req.param('code')), eq(computeNodeDeviceAuthRequests.status, 'pending'))).returning({ id: computeNodeDeviceAuthRequests.requestId })
      if (!row) return c.json({ error: 'Device authorization request not found' }, 404)
      return c.json({ ok: true })
    },
  )

  accountsRouter.openapi(
    createRoute({
      method: 'post', path: '/{accountId}/compute-nodes', tags: ['compute-nodes'],
      summary: 'Register a compute node and create a single-use enrollment token', ...auth,
      request: { params: z.object({ accountId: z.string() }), body: { content: { 'application/json': { schema: z.object({ type: NodeType.default('workstation'), project_id: z.string().nullable().optional(), provider: z.string().optional(), allocation_id: z.string().optional(), update_channel: z.string().default('stable'), concurrency: z.number().int().min(1).max(1024).default(1), metadata: z.record(z.string(), z.any()).optional() }) } } } },
      responses: { 201: json(z.object({ node: NodeSchema, enrollment_token: z.string(), enrollment_expires_at: z.string() }), 'Registered node'), ...errors(400, 401, 403, 409) },
    }),
    async (c: any) => {
      const accountId = c.req.param('accountId')
      await assertAuthorized(await actorOf(c, accountId), ACCOUNT_ACTIONS.TOKEN_CREATE)
      const body = await c.req.json()
      if (!(await authorizeProject(c, accountId, body.project_id, 'manage'))) return c.json({ error: 'Project not found' }, 404)
      const [row] = await db.insert(computeNodes).values({
        accountId,
        projectId: body.project_id ?? null,
        type: body.type ?? 'workstation',
        provider: body.provider ?? null,
        allocationId: body.allocation_id ?? null,
        updateChannel: body.update_channel ?? 'stable',
        concurrency: body.concurrency ?? 1,
        status: 'offline',
        metadata: body.metadata ?? {},
      }).returning()
      if (!row) return c.json({ error: 'Failed to register compute node' }, 409)
      const enrollment = await createNodeEnrollmentToken({ nodeId: row.nodeId, accountId, createdBy: c.get('userId') })
      c.header('Cache-Control', 'no-store')
      return c.json({ node: serializeNode(row), enrollment_token: enrollment.token, enrollment_expires_at: enrollment.expiresAt.toISOString() }, 201)
    },
  )

  accountsRouter.openapi(
    createRoute({ method: 'get', path: '/{accountId}/compute-nodes', tags: ['compute-nodes'], summary: 'List compute nodes', ...auth, request: { params: z.object({ accountId: z.string() }) }, responses: { 200: json(z.object({ nodes: z.array(NodeSchema) }), 'Compute nodes'), ...errors(401, 403) } }),
    async (c: any) => {
      const accountId = c.req.param('accountId')
      await assertAuthorized(await actorOf(c, accountId), ACCOUNT_ACTIONS.TOKEN_READ)
      const rows = await db.select().from(computeNodes).where(and(eq(computeNodes.accountId, accountId), ne(computeNodes.status, 'deleted'))).orderBy(desc(computeNodes.createdAt))
      return c.json({ nodes: rows.map(serializeNode) })
    },
  )

  accountsRouter.openapi(
    createRoute({ method: 'get', path: '/{accountId}/compute-nodes/{nodeId}', tags: ['compute-nodes'], summary: 'Get a compute node', ...auth, request: { params: z.object({ accountId: z.string(), nodeId: z.string() }) }, responses: { 200: json(NodeSchema, 'Compute node'), ...errors(401, 403, 404) } }),
    async (c: any) => {
      const accountId = c.req.param('accountId')
      await assertAuthorized(await actorOf(c, accountId), ACCOUNT_ACTIONS.TOKEN_READ)
      const row = await loadAccountNode(accountId, c.req.param('nodeId'))
      if (!row || !(await authorizeProject(c, accountId, row.projectId, 'read'))) return c.json({ error: 'Not found' }, 404)
      return c.json(serializeNode(row))
    },
  )

  accountsRouter.openapi(
    createRoute({ method: 'patch', path: '/{accountId}/compute-nodes/{nodeId}', tags: ['compute-nodes'], summary: 'Update compute-node policy', ...auth, request: { params: z.object({ accountId: z.string(), nodeId: z.string() }), body: { content: { 'application/json': { schema: z.object({ project_id: z.string().nullable().optional(), update_channel: z.string().optional(), concurrency: z.number().int().min(1).max(1024).optional(), desired_manifest: z.record(z.string(), z.any()).optional(), metadata: z.record(z.string(), z.any()).optional() }) } } } }, responses: { 200: json(NodeSchema, 'Updated node'), ...errors(400, 401, 403, 404) } }),
    async (c: any) => {
      const accountId = c.req.param('accountId')
      await assertAuthorized(await actorOf(c, accountId), ACCOUNT_ACTIONS.ACCOUNT_WRITE)
      const current = await loadAccountNode(accountId, c.req.param('nodeId'))
      if (!current || !(await authorizeProject(c, accountId, current.projectId, 'manage'))) return c.json({ error: 'Not found' }, 404)
      const body = await c.req.json()
      if (body.project_id !== undefined && !(await authorizeProject(c, accountId, body.project_id, 'manage'))) return c.json({ error: 'Project not found' }, 404)
      const [row] = await db.update(computeNodes).set({
        ...(body.project_id !== undefined ? { projectId: body.project_id } : {}),
        ...(body.update_channel !== undefined ? { updateChannel: body.update_channel } : {}),
        ...(body.concurrency !== undefined ? { concurrency: body.concurrency } : {}),
        ...(body.desired_manifest !== undefined ? { desiredManifest: body.desired_manifest } : {}),
        ...(body.metadata !== undefined ? { metadata: body.metadata } : {}),
        updatedAt: new Date(),
      }).where(eq(computeNodes.nodeId, current.nodeId)).returning()
      return c.json(serializeNode(row!))
    },
  )

  for (const action of ['enable', 'disable', 'drain', 'restart'] as const) {
    accountsRouter.openapi(
      createRoute({ method: 'post', path: `/{accountId}/compute-nodes/{nodeId}/${action}`, tags: ['compute-nodes'], summary: `${action} a compute node`, ...auth, request: { params: z.object({ accountId: z.string(), nodeId: z.string() }) }, responses: { 200: json(NodeSchema, 'Updated node'), ...errors(401, 403, 404, 409) } }),
      async (c: any) => {
        const accountId = c.req.param('accountId')
        await assertAuthorized(await actorOf(c, accountId), ACCOUNT_ACTIONS.ACCOUNT_WRITE)
        const current = await loadAccountNode(accountId, c.req.param('nodeId'))
        if (!current || !(await authorizeProject(c, accountId, current.projectId, 'manage'))) return c.json({ error: 'Not found' }, 404)
        const status = action === 'enable' ? 'offline' : action === 'drain' ? 'draining' : action === 'disable' ? 'disabled' : 'offline'
        const metadata = action === 'restart' ? { ...current.metadata, restartRequestedAt: new Date().toISOString() } : current.metadata
        const [row] = await db.update(computeNodes).set({ status, metadata, updatedAt: new Date() }).where(eq(computeNodes.nodeId, current.nodeId)).returning()
        if (action !== 'enable') computeNodeChannel.disconnectNode(current.nodeId, action === 'restart' ? 1012 : 4003, `compute node ${action}`)
        return c.json(serializeNode(row!))
      },
    )
  }

  accountsRouter.openapi(
    createRoute({
      method: 'post', path: '/{accountId}/compute-nodes/{nodeId}/assignments', tags: ['compute-nodes'],
      summary: 'Assign an existing session to a connected compute node', ...auth,
      request: { params: z.object({ accountId: z.string(), nodeId: z.string() }), body: { content: { 'application/json': { schema: z.object({ session_id: z.string().uuid(), lease_seconds: z.number().int().min(60).max(86400).default(3600), ports: z.array(z.number().int().min(1).max(65535)).min(1).max(16).default([8000]), writable_roots: z.array(z.string().min(1)).max(32).default([]) }) } } } },
      responses: { 202: json(AssignmentSchema, 'Assignment accepted for delivery'), ...errors(400, 401, 403, 404, 409) },
    }),
    async (c: any) => {
      const accountId = c.req.param('accountId')
      const nodeId = c.req.param('nodeId')
      await assertAuthorized(await actorOf(c, accountId), ACCOUNT_ACTIONS.ACCOUNT_WRITE)
      const node = await loadAccountNode(accountId, nodeId)
      if (!node || !(await authorizeProject(c, accountId, node.projectId, 'manage'))) return c.json({ error: 'Not found' }, 404)
      if (!computeNodeChannel.isConnected(nodeId) && !nodeRelayIsLive(node)) return c.json({ error: 'Compute node is not connected' }, 409)
      const body = await c.req.json()
      const [runtime] = await db.select({ session: projectSessions, project: projects }).from(projectSessions).innerJoin(projects, eq(projectSessions.projectId, projects.projectId)).where(and(eq(projectSessions.sessionId, body.session_id), eq(projectSessions.accountId, accountId))).limit(1)
      if (!runtime || !(await authorizeProject(c, accountId, runtime.session.projectId, 'manage'))) return c.json({ error: 'Session not found' }, 404)
      if (node.projectId && node.projectId !== runtime.session.projectId) return c.json({ error: 'Compute node is restricted to another project' }, 409)
      const leaseExpiresAt = new Date(Date.now() + (body.lease_seconds ?? 3600) * 1000)
      const inserted = await db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`kortixd-session:${body.session_id}`}))`)
        const active = await tx.select({ id: computeNodeAssignments.assignmentId }).from(computeNodeAssignments).where(and(eq(computeNodeAssignments.sessionId, body.session_id), inArray(computeNodeAssignments.status, ['assigned', 'ready', 'draining']))).limit(1)
        if (active.length) return null
        const nodeActive = await tx.select({ id: computeNodeAssignments.assignmentId }).from(computeNodeAssignments).where(and(eq(computeNodeAssignments.nodeId, nodeId), inArray(computeNodeAssignments.status, ['assigned', 'ready', 'draining'])))
        if (nodeActive.length >= node.concurrency) return null
        const [prior] = await tx.select().from(computeNodeAssignments).where(and(eq(computeNodeAssignments.nodeId, nodeId), eq(computeNodeAssignments.sessionId, body.session_id))).limit(1)
        if (prior) {
          const [row] = await tx.update(computeNodeAssignments).set({ status: 'assigned', leaseEpoch: prior.leaseEpoch + 1, leaseExpiresAt, metadata: {}, updatedAt: new Date() }).where(eq(computeNodeAssignments.assignmentId, prior.assignmentId)).returning()
          return row ?? null
        }
        const [row] = await tx.insert(computeNodeAssignments).values({ nodeId, accountId, projectId: runtime.session.projectId, sessionId: runtime.session.sessionId, status: 'assigned', leaseEpoch: 1, leaseExpiresAt }).returning()
        return row ?? null
      })
      if (!inserted) return c.json({ error: 'Session or compute node has no free assignment capacity' }, 409)
      const sessionToken = await createAccountToken({ accountId, userId: c.get('userId'), projectId: runtime.session.projectId, sessionId: runtime.session.sessionId, name: `Compute Session ${runtime.session.sessionId.slice(0, 8)}`, expiresAt: leaseExpiresAt })
      const assignment: NodeAssignmentSpec = {
        assignment_id: inserted.assignmentId, session_id: runtime.session.sessionId, project_id: runtime.session.projectId,
        lease_epoch: inserted.leaseEpoch, lease_expires_at: leaseExpiresAt.toISOString(), workload: 'session', harness: 'opencode',
        repository: { url: proxyGitUrl(runtime.session.projectId), branch: runtime.session.branchName, base_ref: runtime.session.baseRef },
        secrets_revision: 'current', ports: body.ports ?? [8000], writable_roots: body.writable_roots ?? [],
        env: { KORTIX_CLI_TOKEN: sessionToken.secretKey, KORTIX_API_URL: deriveKortixApiBase() },
      }
      void assignComputeNode(nodeId, assignment).catch(async (error) => {
        await db.update(computeNodeAssignments).set({ status: 'failed', metadata: { detail: error instanceof Error ? error.message : String(error) }, updatedAt: new Date() }).where(eq(computeNodeAssignments.assignmentId, inserted.assignmentId))
      })
      return c.json(serializeAssignment(inserted), 202)
    },
  )

  accountsRouter.openapi(
    createRoute({ method: 'get', path: '/{accountId}/compute-nodes/{nodeId}/assignments', tags: ['compute-nodes'], summary: 'List compute-node assignments', ...auth, request: { params: z.object({ accountId: z.string(), nodeId: z.string() }) }, responses: { 200: json(z.object({ assignments: z.array(AssignmentSchema) }), 'Assignments'), ...errors(401, 403, 404) } }),
    async (c: any) => {
      const accountId = c.req.param('accountId')
      await assertAuthorized(await actorOf(c, accountId), ACCOUNT_ACTIONS.TOKEN_READ)
      const node = await loadAccountNode(accountId, c.req.param('nodeId'))
      if (!node || !(await authorizeProject(c, accountId, node.projectId, 'read'))) return c.json({ error: 'Not found' }, 404)
      const rows = await db.select().from(computeNodeAssignments).where(and(eq(computeNodeAssignments.accountId, accountId), eq(computeNodeAssignments.nodeId, node.nodeId))).orderBy(desc(computeNodeAssignments.createdAt))
      return c.json({ assignments: rows.map(serializeAssignment) })
    },
  )

  accountsRouter.openapi(
    createRoute({ method: 'post', path: '/{accountId}/compute-nodes/{nodeId}/assignments/{assignmentId}/release', tags: ['compute-nodes'], summary: 'Stop and release a compute-node assignment', ...auth, request: { params: z.object({ accountId: z.string(), nodeId: z.string(), assignmentId: z.string().uuid() }) }, responses: { 202: json(AssignmentSchema, 'Release requested'), ...errors(401, 403, 404, 409) } }),
    async (c: any) => {
      const accountId = c.req.param('accountId')
      const nodeId = c.req.param('nodeId')
      const assignmentId = c.req.param('assignmentId')
      await assertAuthorized(await actorOf(c, accountId), ACCOUNT_ACTIONS.ACCOUNT_WRITE)
      const [assignment] = await db.select().from(computeNodeAssignments).where(and(eq(computeNodeAssignments.assignmentId, assignmentId), eq(computeNodeAssignments.nodeId, nodeId), eq(computeNodeAssignments.accountId, accountId))).limit(1)
      if (!assignment || !(await authorizeProject(c, accountId, assignment.projectId, 'manage'))) return c.json({ error: 'Not found' }, 404)
      if (!['assigned', 'ready', 'draining'].includes(assignment.status)) return c.json({ error: 'Assignment is not active' }, 409)
      const node = await loadAccountNode(accountId, nodeId)
      if (!node) return c.json({ error: 'Not found' }, 404)
      if (!computeNodeChannel.isConnected(nodeId) && !nodeRelayIsLive(node)) return c.json({ error: 'Compute node is not connected' }, 409)
      const [updated] = await db.update(computeNodeAssignments).set({ status: 'draining', updatedAt: new Date() }).where(eq(computeNodeAssignments.assignmentId, assignmentId)).returning()
      try { await stopComputeNodeAssignment(nodeId, assignmentId, 'release') }
      catch (error) {
        await db.update(computeNodeAssignments).set({ status: assignment.status, updatedAt: new Date() }).where(eq(computeNodeAssignments.assignmentId, assignmentId))
        return c.json({ error: error instanceof Error ? error.message : String(error) }, 409)
      }
      return c.json(serializeAssignment(updated!), 202)
    },
  )

  accountsRouter.openapi(
    createRoute({ method: 'post', path: '/{accountId}/compute-nodes/{nodeId}/rotate-credential', tags: ['compute-nodes'], summary: 'Revoke the active credential and create a new enrollment token', ...auth, request: { params: z.object({ accountId: z.string(), nodeId: z.string() }) }, responses: { 200: json(z.object({ enrollment_token: z.string(), enrollment_expires_at: z.string() }), 'Single-use enrollment token'), ...errors(401, 403, 404) } }),
    async (c: any) => {
      const accountId = c.req.param('accountId')
      await assertAuthorized(await actorOf(c, accountId), ACCOUNT_ACTIONS.TOKEN_CREATE)
      const current = await loadAccountNode(accountId, c.req.param('nodeId'))
      if (!current || !(await authorizeProject(c, accountId, current.projectId, 'manage'))) return c.json({ error: 'Not found' }, 404)
      await revokeNodeCredentials(current.nodeId, accountId)
      computeNodeChannel.disconnectNode(current.nodeId, 4003, 'compute node credential rotated')
      const enrollment = await createNodeEnrollmentToken({ nodeId: current.nodeId, accountId, createdBy: c.get('userId') })
      c.header('Cache-Control', 'no-store')
      return c.json({ enrollment_token: enrollment.token, enrollment_expires_at: enrollment.expiresAt.toISOString() })
    },
  )

  accountsRouter.openapi(
    createRoute({ method: 'delete', path: '/{accountId}/compute-nodes/{nodeId}', tags: ['compute-nodes'], summary: 'Delete a compute node', ...auth, request: { params: z.object({ accountId: z.string(), nodeId: z.string() }) }, responses: { 200: json(z.object({ ok: z.boolean() }), 'Deleted'), ...errors(401, 403, 404) } }),
    async (c: any) => {
      const accountId = c.req.param('accountId')
      await assertAuthorized(await actorOf(c, accountId), ACCOUNT_ACTIONS.ACCOUNT_WRITE)
      const current = await loadAccountNode(accountId, c.req.param('nodeId'))
      if (!current || !(await authorizeProject(c, accountId, current.projectId, 'manage'))) return c.json({ error: 'Not found' }, 404)
      await db.transaction(async (tx) => {
        await tx.update(computeNodeAssignments).set({ status: 'released', updatedAt: new Date() }).where(eq(computeNodeAssignments.nodeId, current.nodeId))
        await tx.update(computeNodes).set({ status: 'deleted', updatedAt: new Date() }).where(eq(computeNodes.nodeId, current.nodeId))
      })
      await revokeNodeCredentials(current.nodeId, accountId)
      computeNodeChannel.disconnectNode(current.nodeId, 4003, 'compute node deleted')
      return c.json({ ok: true })
    },
  )
}
