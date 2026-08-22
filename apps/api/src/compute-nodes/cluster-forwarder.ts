import { and, eq, lt, sql } from 'drizzle-orm'
import { computeNodeRpcForwards, computeNodes } from '@kortix/db'
import { API_INSTANCE, API_INSTANCE_ID, API_STARTED_AT } from '../shared/instance'
import { db } from '../shared/db'
import { ComputeNodeRpcError, type ComputeNodeChannelHub } from './channel'
import type { NodeAssignmentSpec } from '@kortix/api-contract/node-channel'
import { dispatchForwardedComputeNodeCall, nodeRelayIsLive } from './cluster-protocol'
export { nodeRelayIsLive } from './cluster-protocol'

const POLL_MS = 100
const TIMEOUT_MS = 30_000
let timer: ReturnType<typeof setTimeout> | null = null
let stopped = true
let running = false

export function relayOwnerPatch(now = new Date()) {
  return { relayOwnerId: API_INSTANCE_ID, relayOwnerInstance: API_INSTANCE, relayOwnerStartedAt: new Date(API_STARTED_AT), relayOwnerHeartbeatAt: now }
}

export async function rpcComputeNodeAcrossCluster(hub: ComputeNodeChannelHub, nodeId: string, method: string, params: Record<string, unknown>, timeoutMs = TIMEOUT_MS): Promise<unknown> {
  if (hub.isConnected(nodeId)) return hub.rpc(nodeId, method, params, timeoutMs)
  return queueForward(nodeId, method, params, timeoutMs)
}

export async function assignComputeNodeAcrossCluster(hub: ComputeNodeChannelHub, nodeId: string, assignment: NodeAssignmentSpec, timeoutMs = 120_000): Promise<unknown> {
  if (hub.isConnected(nodeId)) return hub.assign(nodeId, assignment, timeoutMs)
  return queueForward(nodeId, '$assignment.apply', { assignment }, timeoutMs)
}

export async function stopComputeNodeAssignmentAcrossCluster(hub: ComputeNodeChannelHub, nodeId: string, assignmentId: string, reason: 'stop' | 'restart' | 'release' | 'drain'): Promise<unknown> {
  if (hub.isConnected(nodeId)) { hub.stopAssignment(nodeId, assignmentId, reason); return { accepted: true } }
  return queueForward(nodeId, '$assignment.stop', { assignment_id: assignmentId, reason }, TIMEOUT_MS)
}

async function queueForward(nodeId: string, method: string, params: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
  const [node] = await db.select({ accountId: computeNodes.accountId, status: computeNodes.status, relayOwnerId: computeNodes.relayOwnerId, relayOwnerHeartbeatAt: computeNodes.relayOwnerHeartbeatAt }).from(computeNodes).where(eq(computeNodes.nodeId, nodeId)).limit(1)
  if (!node || !nodeRelayIsLive(node)) throw new ComputeNodeRpcError(-32004, `Compute node ${nodeId} is not connected`)
  if (node.relayOwnerId === API_INSTANCE_ID) {
    await db.update(computeNodes).set({ status: 'offline', relayOwnerId: null, relayOwnerInstance: null, relayOwnerStartedAt: null, relayOwnerHeartbeatAt: null, updatedAt: new Date() }).where(and(eq(computeNodes.nodeId, nodeId), eq(computeNodes.relayOwnerId, API_INSTANCE_ID)))
    throw new ComputeNodeRpcError(-32004, `Compute node ${nodeId} is not connected on its relay owner`)
  }
  const [request] = await db.insert(computeNodeRpcForwards).values({
    nodeId, accountId: node.accountId, requesterRelayOwnerId: API_INSTANCE_ID,
    targetRelayOwnerId: node.relayOwnerId!, method, params,
    expiresAt: new Date(Date.now() + timeoutMs + 5_000),
  }).returning({ requestId: computeNodeRpcForwards.requestId })
  if (!request) throw new ComputeNodeRpcError(-32000, 'Failed to queue compute-node RPC')
  const deadline = Date.now() + timeoutMs + 5_000
  while (Date.now() < deadline) {
    const [row] = await db.select().from(computeNodeRpcForwards).where(eq(computeNodeRpcForwards.requestId, request.requestId)).limit(1)
    if (!row) throw new ComputeNodeRpcError(-32000, 'Compute-node RPC forward disappeared')
    if (row.status === 'completed') { await deleteBestEffort(row.requestId); return row.result }
    if (row.status === 'error') {
      await deleteBestEffort(row.requestId)
      throw new ComputeNodeRpcError(row.error?.code ?? -32000, row.error?.message ?? 'Compute-node RPC failed')
    }
    await Bun.sleep(POLL_MS)
  }
  await db.delete(computeNodeRpcForwards).where(eq(computeNodeRpcForwards.requestId, request.requestId))
  throw new ComputeNodeRpcError(-32002, `Compute node RPC timed out after ${timeoutMs}ms`)
}

export function startComputeNodeRpcForwarder(hub: ComputeNodeChannelHub): void {
  if (!stopped) return
  stopped = false
  schedule(hub, 0)
}

export function stopComputeNodeRpcForwarder(): void {
  stopped = true
  if (timer) clearTimeout(timer)
  timer = null
}

function schedule(hub: ComputeNodeChannelHub, delay: number): void {
  if (stopped) return
  timer = setTimeout(() => { void tick(hub) }, delay)
  timer.unref?.()
}

async function tick(hub: ComputeNodeChannelHub): Promise<void> {
  if (running || stopped) return
  running = true
  try {
    const rows = await db.execute<typeof computeNodeRpcForwards.$inferSelect>(sql`
      WITH picked AS (
        SELECT request_id FROM kortix.compute_node_rpc_forwards
        WHERE target_relay_owner_id = ${API_INSTANCE_ID} AND status = 'pending' AND expires_at > now()
        ORDER BY created_at ASC LIMIT 16 FOR UPDATE SKIP LOCKED
      )
      UPDATE kortix.compute_node_rpc_forwards f SET status = 'processing', updated_at = now()
      FROM picked WHERE f.request_id = picked.request_id RETURNING f.*
    `)
    for (const raw of Array.from(rows as unknown as Array<Record<string, unknown>>)) {
      const row = normalize(raw)
      try {
        const [node] = await db.select({ accountId: computeNodes.accountId, relayOwnerId: computeNodes.relayOwnerId }).from(computeNodes).where(eq(computeNodes.nodeId, row.nodeId)).limit(1)
        if (!node || node.accountId !== row.accountId || node.relayOwnerId !== API_INSTANCE_ID || !hub.isConnected(row.nodeId)) throw new ComputeNodeRpcError(-32004, 'Compute node is not connected on the relay owner')
        const result = await dispatchForwardedComputeNodeCall(hub, row)
        await db.update(computeNodeRpcForwards).set({ status: 'completed', result, completedAt: new Date(), updatedAt: new Date() }).where(eq(computeNodeRpcForwards.requestId, row.requestId))
      } catch (error) {
        await db.update(computeNodeRpcForwards).set({ status: 'error', error: { code: error instanceof ComputeNodeRpcError ? error.code : -32000, message: error instanceof Error ? error.message.slice(0, 1024) : String(error).slice(0, 1024) }, completedAt: new Date(), updatedAt: new Date() }).where(eq(computeNodeRpcForwards.requestId, row.requestId))
      }
    }
    await db.delete(computeNodeRpcForwards).where(lt(computeNodeRpcForwards.expiresAt, new Date()))
    schedule(hub, rows.length ? 0 : POLL_MS)
  } catch (error) {
    console.warn('[compute-node-forwarder] tick failed:', error instanceof Error ? error.message : error)
    schedule(hub, 1_000)
  } finally { running = false }
}

function normalize(raw: Record<string, unknown>) {
  return {
    requestId: String(raw.request_id), nodeId: String(raw.node_id), accountId: String(raw.account_id),
    method: String(raw.method), params: (raw.params ?? {}) as Record<string, unknown>, expiresAt: new Date(String(raw.expires_at)),
  }
}

async function deleteBestEffort(requestId: string): Promise<void> {
  await db.delete(computeNodeRpcForwards).where(eq(computeNodeRpcForwards.requestId, requestId)).catch(() => {})
}
