/**
 * Operator: import the goals of one project that exist only as folders in
 * Files (GOAL.md or goal.json, written by `kortix goals` or the SDK before the
 * API held goals) into `project_goals`.
 *
 *   dotenvx run -f apps/api/.env.dev -- bun run apps/api/scripts/import-legacy-goals.ts --env dev --project <project_id> [--apply]
 *
 * Without `--apply` it only reads and prints the plan. `--env` must equal the
 * environment the loaded profile names (INTERNAL_KORTIX_ENV).
 *
 * - Scans `/Company/Goals/<slug>/` and every `/Users/<person>/Goals/<slug>/`.
 * - Each folder becomes one row, `provenance = 'legacy_unverified'`: a legacy
 *   `done` stays done, but every criterion has `verified = false`, because no
 *   API verification ever ran.
 * - Binds the folder's live heartbeat: the reminder whose prompt names the
 *   folder (`Goal wake: <box folder>.`) on a session of the folder's person.
 * - Idempotent on (project, drive, folder): a second run inserts nothing.
 * - Prints ids, paths and counts only. It never prints file contents.
 */
import { projectSessions, projects } from '@kortix/db';
import type { ProjectGoalCriterion } from '@kortix/db';
import { and, eq } from 'drizzle-orm';
import { config } from '../src/config';
import { findProjectDrive, listFolderGrants } from '../src/drives/service';
import { volumeOps } from '../src/memory/volume-ops';
import { listProjectReminders } from '../src/projects/lib/session-reminders';
import { resolveProjectAutomationActor } from '../src/projects/session-lifecycle';
import { derivedUuid } from '../src/projects/goals/service';
import { goalFolderTaken, insertGoal } from '../src/projects/goals/store';
import type { GitTriggerSpec } from '../src/projects/triggers';
import { db } from '../src/shared/db';

type LegacyState = 'draft' | 'active' | 'waiting_on_user' | 'verifying' | 'done' | 'stopped';

function args() {
  const argv = process.argv.slice(2);
  const out = { env: '', project: '', apply: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--env') out.env = argv[++i] ?? '';
    else if (a === '--project') out.project = argv[++i] ?? '';
    else if (a === '--apply') out.apply = true;
    else throw new Error(`unknown argument ${a}`);
  }
  return out;
}

function scalar(raw: string | undefined): string | number | boolean | null {
  const s = (raw ?? '').trim().replace(/\s+#.*$/, '');
  if (s === '' || s === '~' || s === 'null') return null;
  if (s.startsWith('"')) {
    try {
      return JSON.parse(s) as string;
    } catch {
      return s.replace(/^"|"$/g, '');
    }
  }
  if (s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1).replace(/''/g, "'");
  if (s === 'true' || s === 'false') return s === 'true';
  if (/^-?\d+$/.test(s)) return Number(s);
  return s;
}

interface LegacyGoal {
  objective: string;
  state: LegacyState;
  assignedUser: string | null;
  agent: string | null;
  summary: string;
  heartbeat: string | null;
  maxWakes: number | null;
  maxSessions: number | null;
  reminderId: string | null;
  criteria: ProjectGoalCriterion[];
  owners: string[];
}

const STATE_MAP: Record<string, LegacyState> = {
  draft: 'draft',
  active: 'active',
  waiting_on_user: 'waiting_on_user',
  waiting_external: 'active',
  verifying: 'verifying',
  done: 'done',
  stopped: 'stopped',
  abandoned: 'stopped',
};

/** The GOAL.md front matter subset `kortix goals` writes: scalars and lists of flat maps. */
function parseGoalMd(text: string): LegacyGoal | null {
  const m = /^---\n([\s\S]*?)\n---/.exec(text.replace(/\r\n/g, '\n'));
  if (!m) return null;
  const top: Record<string, unknown> = {};
  const lists: Record<string, Array<Record<string, unknown>>> = {};
  let list: string | null = null;
  for (const line of m[1]!.split('\n')) {
    const key = /^([A-Za-z_][\w-]*):(?:\s+(.*))?$/.exec(line);
    if (key) {
      list = key[2] === undefined || key[2] === '' ? key[1]! : null;
      if (list) lists[list] = [];
      else top[key[1]!] = scalar(key[2]);
      continue;
    }
    if (!list) continue;
    const item = /^\s*-\s+([\w-]+):\s*(.*)$/.exec(line);
    const cont = /^\s{3,}([\w-]+):\s*(.*)$/.exec(line);
    if (item) lists[list]!.push({ [item[1]!]: scalar(item[2]) });
    else if (cont && lists[list]!.length) lists[list]![lists[list]!.length - 1]![cont[1]!] = scalar(cont[2]);
  }
  return toLegacy(top, lists);
}

function toLegacy(top: Record<string, unknown>, lists: Record<string, Array<Record<string, unknown>>>): LegacyGoal | null {
  const objective = String(top.goal ?? top.objective ?? '').trim();
  if (!objective) return null;
  const rawCriteria = lists.done_criteria ?? lists.success_criteria ?? [];
  return {
    objective,
    state: STATE_MAP[String(top.state ?? top.status ?? 'draft')] ?? 'draft',
    assignedUser: typeof top.assigned_user === 'string' ? top.assigned_user : null,
    agent: typeof (top.assigned_agent ?? top.agent) === 'string' ? String(top.assigned_agent ?? top.agent) : null,
    summary: typeof top.summary === 'string' ? top.summary : '',
    heartbeat: typeof top.heartbeat === 'string' ? top.heartbeat : null,
    maxWakes: typeof top.max_wakes_per_day === 'number' ? top.max_wakes_per_day : null,
    maxSessions: typeof top.max_sessions === 'number' ? top.max_sessions : null,
    reminderId: typeof top.reminder_id === 'string' ? top.reminder_id : null,
    criteria: rawCriteria.slice(0, 8).map((c, i) => ({
      id: `c${i + 1}`,
      text: String(c.text ?? '').slice(0, 500),
      reported_met: c.met === true,
      evidence: typeof c.evidence === 'string' ? c.evidence : null,
      // No API verification ever ran on a legacy goal.
      verified: false,
    })),
    owners: (lists.sessions ?? []).filter((s) => s.role === 'owner' && typeof s.id === 'string').map((s) => String(s.id)),
  };
}

function parseGoalJson(text: string): LegacyGoal | null {
  try {
    const doc = JSON.parse(text) as Record<string, unknown>;
    const criteria = Array.isArray(doc.success_criteria) ? (doc.success_criteria as Array<Record<string, unknown>>) : [];
    const sessions = Array.isArray(doc.sessions) ? (doc.sessions as Array<Record<string, unknown>>) : [];
    return toLegacy(doc, { done_criteria: criteria, sessions });
  } catch {
    return null;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function main() {
  const opts = args();
  if (!opts.env || opts.env !== config.INTERNAL_KORTIX_ENV) {
    throw new Error(`--env ${opts.env || '(missing)'} does not match the loaded profile's environment (${config.INTERNAL_KORTIX_ENV})`);
  }
  if (!UUID.test(opts.project)) throw new Error('--project <project_id> is required');
  const [project] = await db.select().from(projects).where(eq(projects.projectId, opts.project)).limit(1);
  if (!project) throw new Error(`project ${opts.project} not found`);
  const drive = await findProjectDrive(project.projectId);
  if (!drive) throw new Error('the project has no Files drive');
  const ops = volumeOps();
  if (!ops.available()) throw new Error('Files storage is not configured in this profile');

  // Personal folder → its person, from the folder grants Kortix made.
  const grants = await listFolderGrants(drive);
  const personOf = new Map<string, string>();
  for (const g of grants) {
    if (g.source === 'system' && g.principalType === 'user' && g.level === 'manage' && /^\/Users\/[^/]+$/.test(g.path)) personOf.set(g.path, g.principalId);
  }
  const fallbackCreator = await resolveProjectAutomationActor(project.accountId);
  const reminders = await listProjectReminders(project.projectId);

  const entries = [...(await ops.list(drive, '/Company/Goals')), ...(await ops.list(drive, '/Users'))];
  const folders = new Map<string, 'md' | 'json'>();
  for (const e of entries) {
    const m = /^(\/(?:Company|Users\/[^/]+)\/Goals\/[^/]+)\/(GOAL\.md|goal\.json)$/.exec(e.path);
    if (!m || e.type !== 'file') continue;
    if (m[2] === 'GOAL.md' || !folders.has(m[1]!)) folders.set(m[1]!, m[2] === 'GOAL.md' ? 'md' : 'json');
  }

  const counts = { folders: folders.size, imported: 0, existing: 0, unreadable: 0, heartbeats: 0 };
  for (const [folder, kind] of [...folders].sort()) {
    if (await goalFolderTaken(project.projectId, drive.driveId, folder)) {
      counts.existing += 1;
      console.log(`exists    ${folder}`);
      continue;
    }
    const file = await ops.read(drive, `${folder}/${kind === 'md' ? 'GOAL.md' : 'goal.json'}`);
    const legacy = file ? (kind === 'md' ? parseGoalMd(file.text) : parseGoalJson(file.text)) : null;
    if (!legacy) {
      counts.unreadable += 1;
      console.log(`unreadable ${folder}`);
      continue;
    }
    const slug = folder.split('/').pop()!;
    const personal = folder.startsWith('/Users/') ? folder.split('/').slice(0, 3).join('/') : null;
    const person = personal ? (personOf.get(personal) ?? null) : null;
    const boxFolder = personal ? `/drives/me/Goals/${slug}` : `/drives/company/Goals/${slug}`;
    const marker = `Goal wake: ${boxFolder}.`;
    // The heartbeat on a session of this folder's person (a personal alias is shared by everyone).
    let heartbeat: { id: string; sessionId: string } | null = null;
    for (const r of reminders) {
      const spec = r.scheduleSpec as unknown as GitTriggerSpec;
      if (!r.sessionId || !(spec.promptTemplate ?? '').includes(marker)) continue;
      if (legacy.reminderId && r.slug !== legacy.reminderId) continue;
      if (person) {
        const [s] = await db.select({ createdBy: projectSessions.createdBy }).from(projectSessions).where(and(eq(projectSessions.sessionId, r.sessionId), eq(projectSessions.projectId, project.projectId))).limit(1);
        if (s?.createdBy !== person) continue;
      }
      heartbeat = { id: r.slug, sessionId: r.sessionId };
      break;
    }
    const creator = person ?? fallbackCreator;
    if (!creator) {
      counts.unreadable += 1;
      console.log(`no-owner  ${folder}`);
      continue;
    }
    const owner = heartbeat?.sessionId ?? legacy.owners[legacy.owners.length - 1] ?? null;
    const goalId = derivedUuid(project.projectId, drive.driveId, folder);
    console.log(`${opts.apply ? 'import' : 'would'}    ${folder} goal=${goalId} state=${legacy.state} criteria=${legacy.criteria.length} heartbeat=${heartbeat?.id ?? '-'} owner=${owner ?? '-'}`);
    if (heartbeat) counts.heartbeats += 1;
    if (!opts.apply) continue;
    const inserted = await insertGoal(
      {
        goalId,
        projectId: project.projectId,
        accountId: project.accountId,
        title: legacy.objective.split('\n')[0]!.slice(0, 200),
        state: legacy.state,
        summary: legacy.summary.slice(0, 2_000),
        assignedUserId: legacy.assignedUser && UUID.test(legacy.assignedUser) ? legacy.assignedUser : null,
        createdByUserId: creator,
        agent: legacy.agent,
        driveId: drive.driveId,
        folder,
        boxFolder,
        slug,
        ownerSessionId: owner,
        sessions: owner ? [{ id: owner, role: 'owner', since: new Date().toISOString() }] : [],
        criteriaRevision: legacy.criteria.length ? 1 : 0,
        criteria: legacy.criteria,
        heartbeatReminderId: legacy.state === 'done' || legacy.state === 'stopped' ? null : (heartbeat?.id ?? null),
        heartbeatEvery: legacy.heartbeat ?? '4h',
        maxWakesPerDay: Math.min(Math.max(legacy.maxWakes ?? 12, 1), 48),
        maxSessions: Math.min(Math.max(legacy.maxSessions ?? 10, 1), 50),
        setup: { session: true, files: true, heartbeat: true, prompt: true, imported: true },
        provenance: 'legacy_unverified',
      },
      { kind: 'imported', actorKind: 'platform', actorId: null, message: 'Imported from a legacy Goals folder; never verified by the API.', data: { folder } },
    );
    if (inserted) counts.imported += 1;
    else counts.existing += 1;
  }
  console.log(JSON.stringify({ project_id: project.projectId, apply: opts.apply, ...counts }));
  process.exit(0);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
