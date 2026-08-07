import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { accounts, projects, sessionLifecycleCommands } from "@kortix/db";
import { eq } from "drizzle-orm";
import { db } from "../shared/db";
import {
  LIFECYCLE_COMMAND_LEASE_MS,
  claimDueLifecycleCommands,
  lifecycleCommandClaim,
  markCommandSucceeded,
} from "../projects/session-lifecycle/store";

const CONFIRMATION = "I_UNDERSTAND_THIS_DELETES_TEST_DATA";
const enabled = Boolean(
  process.env.TEST_DATABASE_URL &&
  process.env.DATABASE_URL === process.env.TEST_DATABASE_URL &&
  process.env.KORTIX_TEST_DB_CONFIRM === CONFIRMATION &&
  process.env.INTERNAL_KORTIX_ENV !== "prod",
);
const describeWithDb = enabled ? describe : describe.skip;

const ACCOUNT_ID = "00000000-0000-4000-a000-00000000f101";
const PROJECT_ID = "00000000-0000-4000-a000-00000000f102";

async function cleanup() {
  await db.delete(projects).where(eq(projects.projectId, PROJECT_ID));
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT_ID));
}

async function seed() {
  await db
    .insert(accounts)
    .values({ accountId: ACCOUNT_ID, name: "Lifecycle fence proof" });
  await db.insert(projects).values({
    projectId: PROJECT_ID,
    accountId: ACCOUNT_ID,
    name: "Lifecycle fence proof",
    repoUrl: "https://example.test/lifecycle-fence.git",
  });
  await db.insert(sessionLifecycleCommands).values({
    commandType: "create_session",
    source: "api",
    status: "queued",
    projectId: PROJECT_ID,
    accountId: ACCOUNT_ID,
    payload: {},
    result: {},
    availableAt: new Date("2026-08-07T00:00:00.000Z"),
  });
}

describeWithDb("lifecycle command claim fence — real PostgreSQL", () => {
  beforeEach(async () => {
    await cleanup();
    await seed();
  });
  afterEach(cleanup);

  test("a stale executor cannot overwrite a command after lease expiry and reclaim", async () => {
    const startedAt = new Date("2026-08-07T01:00:00.000Z");
    const [first] = await claimDueLifecycleCommands({
      workerId: "worker-a",
      limit: 1,
      now: startedAt,
    });
    expect(first).toBeDefined();
    expect(first.lockedUntil).toEqual(
      new Date(startedAt.getTime() + LIFECYCLE_COMMAND_LEASE_MS),
    );

    const [reclaimed] = await claimDueLifecycleCommands({
      workerId: "worker-b",
      limit: 1,
      now: new Date(startedAt.getTime() + LIFECYCLE_COMMAND_LEASE_MS + 1),
    });
    expect(reclaimed.attempts).toBe(first.attempts + 1);

    expect(
      await markCommandSucceeded(
        first.commandId,
        { worker: "stale" },
        null,
        lifecycleCommandClaim(first),
      ),
    ).toBe(false);
    expect(
      await markCommandSucceeded(
        reclaimed.commandId,
        { worker: "current" },
        null,
        lifecycleCommandClaim(reclaimed),
      ),
    ).toBe(true);

    const [persisted] = await db
      .select()
      .from(sessionLifecycleCommands)
      .where(eq(sessionLifecycleCommands.commandId, first.commandId));
    expect(persisted.status).toBe("succeeded");
    expect(persisted.result).toEqual({ worker: "current" });
  });
});
