/**
 * Project provisioning throttle. Each provision creates a REAL managed GitHub
 * repo; firing many concurrently trips GitHub's secondary rate limit (403). So we
 * cap concurrent provisions with a semaphore and retry on rate-limit with backoff.
 * Everything else in the suite stays fully parallel.
 */
import type { Client } from "../core/client";
import { sleep } from "../core/poll";

const MAX = Number(process.env.KE2E_PROVISION_CONCURRENCY ?? 2);
let active = 0;
const waiters: Array<() => void> = [];

async function acquire(): Promise<void> {
  if (active < MAX) {
    active++;
    return;
  }
  await new Promise<void>((resolve) => waiters.push(resolve));
  active++;
}
function release(): void {
  active--;
  waiters.shift()?.();
}

const RATE_LIMIT_RE = /rate limit|secondary rate|temporarily blocked|abuse/i;

/** Provision a project via /v1/projects/provision, throttled + rate-limit-retried. */
export async function provisionProject(client: Client, body: Record<string, unknown>): Promise<string> {
  await acquire();
  try {
    let lastText = "";
    for (let attempt = 0; attempt < 5; attempt++) {
      const r = await client.post("/v1/projects/provision", body);
      const id = (r.json<any>() ?? {})?.project_id;
      if (id) return id as string;
      lastText = r.text();
      if (!RATE_LIMIT_RE.test(lastText) || attempt === 4) break;
      // GitHub secondary rate limit — back off increasingly before retrying.
      await sleep(10_000 * (attempt + 1));
    }
    throw new Error(`project provision returned no id: ${lastText}`);
  } finally {
    release();
  }
}
