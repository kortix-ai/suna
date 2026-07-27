import {
  accounts,
  kortixApiKeys,
  projectSessions,
  projects,
  sessionSandboxes,
} from "@kortix/db";
import { eq } from "drizzle-orm";
import { createApiKey } from "../src/repositories/api-keys";
import { db } from "../src/shared/db";

const apiBaseUrl = (
  process.env.KORTIX_API_URL ?? "http://localhost:8008/v1"
).replace(/\/$/, "");
const accountId = crypto.randomUUID();
const projectId = crypto.randomUUID();
const sessionId = crypto.randomUUID();
const sandboxId = crypto.randomUUID();

interface LeaseResponse {
  ok: boolean;
  lease_until?: string | null;
  provider_url?: string | null;
  provider_headers?: Record<string, string> | null;
}

interface LeaseProof {
  action: "acquire" | "renew" | "release";
  status: number;
  elapsed_ms: number;
  response: LeaseResponse;
  stored_lease_until: string | null;
}

function storedLeaseUntil(
  metadata: Record<string, unknown> | null,
): string | null {
  const value = metadata?.executionLeaseUntil;
  return typeof value === "string" ? value : null;
}

async function readStoredLeaseUntil(): Promise<string | null> {
  const [row] = await db
    .select({ metadata: sessionSandboxes.metadata })
    .from(sessionSandboxes)
    .where(eq(sessionSandboxes.sandboxId, sandboxId))
    .limit(1);
  if (!row) throw new Error("The disposable sandbox row is missing");
  return storedLeaseUntil(row.metadata);
}

async function callLease(
  token: string,
  action: LeaseProof["action"],
): Promise<LeaseProof> {
  const startedAt = performance.now();
  const response = await fetch(
    `${apiBaseUrl}/projects/${projectId}/execution-lease`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        action,
        session_id: sessionId,
        lease_ttl_seconds: 180,
      }),
    },
  );
  const elapsedMs = performance.now() - startedAt;
  const body = (await response.json()) as LeaseResponse;
  return {
    action,
    status: response.status,
    elapsed_ms: Math.round(elapsedMs * 10) / 10,
    response: body,
    stored_lease_until: await readStoredLeaseUntil(),
  };
}

function assertLeaseProof(proof: LeaseProof): void {
  if (proof.status !== 200 || !proof.response.ok) {
    throw new Error(`${proof.action} failed: ${JSON.stringify(proof)}`);
  }
  if (proof.action === "release") {
    if (proof.stored_lease_until !== null) {
      throw new Error(`release retained lease ${proof.stored_lease_until}`);
    }
    return;
  }
  if (!proof.response.lease_until) {
    throw new Error(`${proof.action} returned no lease_until`);
  }
  if (proof.stored_lease_until !== proof.response.lease_until) {
    throw new Error(
      `${proof.action} response/database mismatch: ` +
        `${proof.response.lease_until} !== ${proof.stored_lease_until}`,
    );
  }
}

let keyId: string | null = null;

try {
  await db
    .insert(accounts)
    .values({ accountId, name: "Execution lease live proof" });
  await db.insert(projects).values({
    projectId,
    accountId,
    name: "Execution lease live proof",
    repoUrl: `https://example.invalid/${projectId}.git`,
  });
  await db.insert(projectSessions).values({
    sessionId,
    accountId,
    projectId,
    branchName: `proof-${sessionId}`,
    sandboxId,
    status: "running",
  });
  await db.insert(sessionSandboxes).values({
    sandboxId,
    sessionId,
    accountId,
    projectId,
    provider: "daytona",
    status: "provisioning",
  });
  const key = await createApiKey({
    sandboxId,
    accountId,
    title: "Execution lease live proof",
    type: "sandbox",
  });
  keyId = key.keyId;

  const proofs: LeaseProof[] = [];
  for (const action of ["acquire", "renew", "release"] as const) {
    const proof = await callLease(key.secretKey, action);
    assertLeaseProof(proof);
    proofs.push(proof);
  }

  console.log(
    JSON.stringify(
      {
        api_base_url: apiBaseUrl,
        project_id: projectId,
        session_id: sessionId,
        sandbox_id: sandboxId,
        proofs,
      },
      null,
      2,
    ),
  );
} finally {
  if (keyId) {
    await db.delete(kortixApiKeys).where(eq(kortixApiKeys.keyId, keyId));
  }
  await db
    .delete(sessionSandboxes)
    .where(eq(sessionSandboxes.sandboxId, sandboxId));
  await db
    .delete(projectSessions)
    .where(eq(projectSessions.sessionId, sessionId));
  await db.delete(projects).where(eq(projects.projectId, projectId));
  await db.delete(accounts).where(eq(accounts.accountId, accountId));
}
