/**
 * The inline artifact-comment dispatch never claims a job whose attempts are
 * spent (real PostgreSQL). `dispatchArtifactCommentJobs` claims by key outside
 * the queue runner, and it had no attempt limit: a job whose run killed its
 * replica was claimed again on every dispatch, its attempts past
 * `max_attempts`. Ending such a job `dead` is the runner's job
 * (`shared/job-queue.ts` runJob).
 */
import { afterAll, expect, test } from 'bun:test';
import { jobQueue } from '@kortix/db';
import { eq } from 'drizzle-orm';
import { dispatchArtifactCommentJobs } from '../artifacts/comment-delivery';
import { db } from '../shared/db';

const KEY = `dispatch-attempts-${crypto.randomUUID()}`;

afterAll(async () => {
  await db.delete(jobQueue).where(eq(jobQueue.jobKey, KEY));
});

test('a job at its attempt limit is not claimed by an inline dispatch', async () => {
  await db.insert(jobQueue).values({
    queue: 'artifact-comment-people',
    jobKey: KEY,
    payload: {},
    attempts: 8,
    maxAttempts: 8,
  });
  await dispatchArtifactCommentJobs(KEY);
  const [row] = await db.select().from(jobQueue).where(eq(jobQueue.jobKey, KEY));
  expect(row!.attempts).toBe(8);
  expect(row!.lockedUntil).toBeNull();
});
