// Persistence for public demo-request submissions (the /contact qualifier and
// the /careers application form both POST here through the web server).
//
// The whole submission is stored as one JSON blob in public.contact_forms, so a
// marketing form can add or rename a field without a DB migration. The write
// lives API-side because the web app must not hold database credentials; it used
// to run as an anon Supabase INSERT straight from the Next.js route.
//
// Best-effort by contract: this never throws and never blocks lead capture. A
// missing table, a missing DATABASE_URL, or a dead pool is logged and reported
// as `false` — the caller still answers 200 and still sends the notification.
import { sql } from 'drizzle-orm';
import { db, hasDatabase } from '../shared/db';

/**
 * Ceiling on the serialized blob. The endpoint is public and unauthenticated
 * and the row stores unknown keys verbatim, so one caller must not be able to
 * write an unbounded payload into the primary database.
 */
const MAX_BLOB_CHARS = 64 * 1024;

/** Fields the notification email renders — kept when a payload is over-sized. */
function compact(data: Record<string, unknown>): Record<string, unknown> {
  return {
    name: data.name,
    email: data.email,
    company_name: data.company_name,
    company_size: data.company_size,
    goal: typeof data.goal === 'string' ? data.goal.slice(0, 2000) : data.goal,
    qualified: data.qualified,
    source: data.source,
    form: data.form,
    user_agent: data.user_agent,
    truncated: true,
  };
}

/**
 * Insert one submission into public.contact_forms. Returns true only when the
 * row is written; every failure path returns false after logging.
 */
export async function recordDemoRequestSubmission(
  data: Record<string, unknown>,
): Promise<boolean> {
  if (!hasDatabase) {
    console.error('[system/demo-request] no DATABASE_URL; lead not persisted');
    return false;
  }

  let blob: string;
  try {
    blob = JSON.stringify(data);
  } catch (err) {
    console.error('[system/demo-request] payload not serializable:', (err as Error).message);
    return false;
  }
  if (blob.length > MAX_BLOB_CHARS) blob = JSON.stringify(compact(data));

  try {
    await db.execute(sql`INSERT INTO public.contact_forms (data) VALUES (${blob}::jsonb)`);
    return true;
  } catch (err) {
    console.error('[system/demo-request] contact_forms insert failed:', (err as Error).message);
    return false;
  }
}
