import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import {
  computeNodeCredentials,
  computeNodeEnrollmentTokens,
  computeNodes,
} from '@kortix/db'
import { db } from '../shared/db'
import {
  candidateSecretKeyHashes,
  generateNodeCredential,
  generateNodeEnrollmentToken,
  hashSecretKey,
  isNodeCredential,
  isNodeEnrollmentToken,
} from '../shared/crypto'

const ENROLLMENT_TTL_MS = 10 * 60 * 1000

export async function createNodeEnrollmentToken(input: {
  nodeId: string
  accountId: string
  createdBy?: string | null
  ttlMs?: number
}): Promise<{ token: string; expiresAt: Date }> {
  const token = generateNodeEnrollmentToken()
  const expiresAt = new Date(Date.now() + Math.min(Math.max(input.ttlMs ?? ENROLLMENT_TTL_MS, 60_000), ENROLLMENT_TTL_MS))
  await db.insert(computeNodeEnrollmentTokens).values({
    nodeId: input.nodeId,
    accountId: input.accountId,
    secretHash: hashSecretKey(token),
    expiresAt,
    createdBy: input.createdBy ?? null,
  })
  return { token, expiresAt }
}

async function issueCredential(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  nodeId: string,
  accountId: string,
): Promise<{ credential: string; publicPrefix: string; generation: number }> {
  const [last] = await tx
    .select({ generation: computeNodeCredentials.generation })
    .from(computeNodeCredentials)
    .where(eq(computeNodeCredentials.nodeId, nodeId))
    .orderBy(desc(computeNodeCredentials.generation))
    .limit(1)
  const generation = (last?.generation ?? 0) + 1
  const generated = generateNodeCredential()
  await tx.insert(computeNodeCredentials).values({
    nodeId,
    accountId,
    publicPrefix: generated.publicPrefix,
    secretHash: hashSecretKey(generated.secret),
    generation,
  })
  return { credential: generated.secret, publicPrefix: generated.publicPrefix, generation }
}

export async function consumeNodeEnrollmentToken(token: string): Promise<{
  nodeId: string
  accountId: string
  credential: string
  publicPrefix: string
  generation: number
} | null> {
  if (!isNodeEnrollmentToken(token)) return null
  return db.transaction(async (tx) => {
    const [enrollment] = await tx
      .update(computeNodeEnrollmentTokens)
      .set({ consumedAt: new Date() })
      .where(and(
        inArray(computeNodeEnrollmentTokens.secretHash, candidateSecretKeyHashes(token)),
        isNull(computeNodeEnrollmentTokens.consumedAt),
        sql`${computeNodeEnrollmentTokens.expiresAt} > now()`,
      ))
      .returning({
        nodeId: computeNodeEnrollmentTokens.nodeId,
        accountId: computeNodeEnrollmentTokens.accountId,
      })
    if (!enrollment) return null
    const issued = await issueCredential(tx, enrollment.nodeId, enrollment.accountId)
    return { ...enrollment, ...issued }
  })
}

export async function createInitialNodeCredential(nodeId: string, accountId: string) {
  return db.transaction((tx) => issueCredential(tx, nodeId, accountId))
}

export async function rotateNodeCredential(nodeId: string, accountId: string) {
  return db.transaction(async (tx) => {
    await tx
      .update(computeNodeCredentials)
      .set({ status: 'revoked', revokedAt: new Date() })
      .where(and(
        eq(computeNodeCredentials.nodeId, nodeId),
        eq(computeNodeCredentials.accountId, accountId),
        eq(computeNodeCredentials.status, 'active'),
      ))
    return issueCredential(tx, nodeId, accountId)
  })
}

export async function revokeNodeCredentials(nodeId: string, accountId: string): Promise<void> {
  await db
    .update(computeNodeCredentials)
    .set({ status: 'revoked', revokedAt: new Date() })
    .where(and(
      eq(computeNodeCredentials.nodeId, nodeId),
      eq(computeNodeCredentials.accountId, accountId),
      eq(computeNodeCredentials.status, 'active'),
    ))
}

export async function validateNodeCredential(token: string, claimedNodeId: string): Promise<{
  nodeId: string
  accountId: string
} | null> {
  if (!isNodeCredential(token)) return null
  const [row] = await db
    .select({
      credentialId: computeNodeCredentials.credentialId,
      nodeId: computeNodeCredentials.nodeId,
      accountId: computeNodeCredentials.accountId,
      expiresAt: computeNodeCredentials.expiresAt,
      nodeStatus: computeNodes.status,
    })
    .from(computeNodeCredentials)
    .innerJoin(computeNodes, eq(computeNodes.nodeId, computeNodeCredentials.nodeId))
    .where(and(
      eq(computeNodeCredentials.nodeId, claimedNodeId),
      inArray(computeNodeCredentials.secretHash, candidateSecretKeyHashes(token)),
      eq(computeNodeCredentials.status, 'active'),
    ))
    .limit(1)
  if (!row || (row.expiresAt && row.expiresAt <= new Date())) return null
  if (row.nodeStatus === 'disabled' || row.nodeStatus === 'draining' || row.nodeStatus === 'deleted') return null
  void db
    .update(computeNodeCredentials)
    .set({ lastUsedAt: new Date() })
    .where(eq(computeNodeCredentials.credentialId, row.credentialId))
    .catch(() => {})
  return { nodeId: row.nodeId, accountId: row.accountId }
}

/** Resolve a node credential without trusting a caller-supplied node id. */
export async function validateNodeCredentialAny(token: string): Promise<{ nodeId: string; accountId: string } | null> {
  if (!isNodeCredential(token)) return null
  const [row] = await db.select({ credentialId: computeNodeCredentials.credentialId, nodeId: computeNodeCredentials.nodeId, accountId: computeNodeCredentials.accountId, expiresAt: computeNodeCredentials.expiresAt, nodeStatus: computeNodes.status }).from(computeNodeCredentials).innerJoin(computeNodes, eq(computeNodes.nodeId, computeNodeCredentials.nodeId)).where(and(inArray(computeNodeCredentials.secretHash, candidateSecretKeyHashes(token)), eq(computeNodeCredentials.status, 'active'))).limit(1)
  if (!row || (row.expiresAt && row.expiresAt <= new Date()) || ['disabled', 'draining', 'deleted'].includes(row.nodeStatus)) return null
  void db.update(computeNodeCredentials).set({ lastUsedAt: new Date() }).where(eq(computeNodeCredentials.credentialId, row.credentialId)).catch(() => {})
  return { nodeId: row.nodeId, accountId: row.accountId }
}
