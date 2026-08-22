import { createRoute, z } from '@hono/zod-openapi'
import { makeOpenApiApp, errors, json } from '../openapi'
import type { AppEnv } from '../types'
import { consumeNodeEnrollmentToken } from '../repositories/compute-node-credentials'
import { revokeNodeCredentials, validateNodeCredential } from '../repositories/compute-node-credentials'
import { computeNodeChannel } from '.'
import { runtimeAssetSigningPublicKey } from '../runtime-assets/manifest'
import { computeNodeDeviceAuthRequests } from '@kortix/db'
import { eq } from 'drizzle-orm'
import { db } from '../shared/db'
import { config } from '../config'
import { generateDeviceCode, hashSecretKey, randomAlphanumeric, verifySecretKey } from '../shared/crypto'
import { decryptEnrollment } from './device-auth'

export const computeNodePublicApp = makeOpenApiApp<AppEnv>()

const DEVICE_AUTH_TTL_MS = 5 * 60_000

computeNodePublicApp.openapi(
  createRoute({ method: 'post', path: '/device-auth', tags: ['compute-nodes'], summary: 'Create a browser-approved node enrollment challenge', request: { body: { content: { 'application/json': { schema: z.object({ machine_hostname: z.string().min(1).max(255), type: z.enum(['workstation', 'vm', 'container', 'bare_metal', 'ci']).default('workstation') }) } } } }, responses: { 201: json(z.object({ device_code: z.string(), device_secret: z.string(), verification_url: z.string(), expires_at: z.string(), poll_interval_ms: z.number() }), 'Device authorization challenge'), ...errors(400, 429) } }),
  async (c: any) => {
    const body = await c.req.json()
    const deviceSecret = randomAlphanumeric(32)
    const expiresAt = new Date(Date.now() + DEVICE_AUTH_TTL_MS)
    let deviceCode = ''
    for (let attempt = 0; attempt < 5; attempt++) {
      deviceCode = generateDeviceCode()
      try {
        await db.insert(computeNodeDeviceAuthRequests).values({ deviceCode, secretHash: hashSecretKey(deviceSecret), machineHostname: body.machine_hostname, nodeType: body.type ?? 'workstation', expiresAt })
        break
      } catch (error) {
        if (!(error && typeof error === 'object' && 'code' in error && error.code === '23505')) throw error
        if (attempt === 4) throw error
      }
    }
    c.header('Cache-Control', 'no-store')
    return c.json({ device_code: deviceCode, device_secret: deviceSecret, verification_url: `${config.FRONTEND_URL.replace(/\/$/, '')}/nodes/authorize/${deviceCode}`, expires_at: expiresAt.toISOString(), poll_interval_ms: 1000 }, 201)
  },
)

computeNodePublicApp.openapi(
  createRoute({ method: 'get', path: '/device-auth/{code}/status', tags: ['compute-nodes'], summary: 'Poll browser-approved node enrollment', request: { params: z.object({ code: z.string() }) }, responses: { 200: json(z.object({ status: z.enum(['pending', 'approved', 'denied', 'expired']), enrollment_token: z.string().optional(), artifact_signing_public_key: z.string().nullable().optional() }), 'Device authorization status'), ...errors(400, 401, 404) } }),
  async (c: any) => {
    const secret = (c.req.header('authorization') ?? '').replace(/^Bearer\s+/i, '')
    if (!secret) return c.json({ error: 'Device secret is required' }, 400)
    const [row] = await db.select().from(computeNodeDeviceAuthRequests).where(eq(computeNodeDeviceAuthRequests.deviceCode, c.req.param('code'))).limit(1)
    if (!row) return c.json({ error: 'Device authorization request not found' }, 404)
    if (!verifySecretKey(secret, row.secretHash)) return c.json({ error: 'Device secret is invalid' }, 401)
    c.header('Cache-Control', 'no-store')
    if (row.expiresAt <= new Date() && row.status === 'pending') return c.json({ status: 'expired' })
    if (row.status === 'approved' && row.encryptedEnrollment) return c.json({ status: 'approved', enrollment_token: decryptEnrollment(row.encryptedEnrollment, row.secretHash), artifact_signing_public_key: runtimeAssetSigningPublicKey() })
    return c.json({ status: row.status })
  },
)

computeNodePublicApp.openapi(
  createRoute({
    method: 'post',
    path: '/enroll',
    tags: ['compute-nodes'],
    summary: 'Exchange a single-use enrollment token for one node credential',
    request: {
      body: {
        content: {
          'application/json': {
            schema: z.object({ enrollment_token: z.string().min(1) }),
          },
        },
      },
    },
    responses: {
      200: json(z.object({
        compute_node_id: z.string(),
        credential: z.string(),
        generation: z.number(),
        artifact_signing_public_key: z.string().nullable(),
      }), 'Node credential returned once'),
      ...errors(400, 401),
    },
  }),
  async (c: any) => {
    const body = await c.req.json().catch(() => null)
    if (!body || typeof body.enrollment_token !== 'string') {
      return c.json({ error: 'enrollment_token is required' }, 400)
    }
    const result = await consumeNodeEnrollmentToken(body.enrollment_token)
    if (!result) return c.json({ error: 'Enrollment token is invalid, expired, or consumed' }, 401)
    c.header('Cache-Control', 'no-store')
    return c.json({
      compute_node_id: result.nodeId,
      credential: result.credential,
      generation: result.generation,
      artifact_signing_public_key: runtimeAssetSigningPublicKey(),
    }, 200)
  },
)

computeNodePublicApp.openapi(
  createRoute({
    method: 'post',
    path: '/logout',
    tags: ['compute-nodes'],
    summary: 'Revoke the credential used by this compute node',
    request: {
      body: { content: { 'application/json': { schema: z.object({ compute_node_id: z.string() }) } } },
    },
    responses: { 200: json(z.object({ ok: z.boolean() }), 'Credential revoked'), ...errors(400, 401) },
  }),
  async (c: any) => {
    const body = await c.req.json().catch(() => null)
    const nodeId = body?.compute_node_id
    const authorization = c.req.header('authorization') ?? ''
    const token = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : ''
    if (typeof nodeId !== 'string' || !token) return c.json({ error: 'Node credential is required' }, 400)
    const identity = await validateNodeCredential(token, nodeId)
    if (!identity) return c.json({ error: 'Node credential is invalid' }, 401)
    await revokeNodeCredentials(nodeId, identity.accountId)
    computeNodeChannel.disconnectNode(nodeId, 4003, 'compute node logged out')
    return c.json({ ok: true })
  },
)
