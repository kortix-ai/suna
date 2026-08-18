/**
 * The one-time hand-off from the browser queue to the server prompt inbox.
 *
 * `kortix_message_queue_v3` was the message queue: a per-session localStorage
 * blob, written by a store that no longer exists. Deleting that store without
 * this module would delete whatever a user had waiting when they last closed
 * the tab — silently, on the deploy that was supposed to make the queue
 * durable. So every recoverable row is POSTed to `POST .../prompts` before the
 * key goes.
 *
 * Three rules make this safe to run more than once, which it will be:
 *
 *  1. **The `clientMessageId` is carried verbatim.** The inbox's idempotency
 *     key is `prompt:<sessionId>:<clientMessageId>` behind a unique index, so a
 *     second pass over the same row is a 200 `deduped`, not a duplicate prompt.
 *     Minting a fresh id here would turn every retry into a re-send.
 *  2. **The key is removed only when nothing is left.** A row that failed, one
 *     whose session cannot be mapped, and a `/` command all stay in the blob;
 *     the blob is rewritten with exactly those.
 *  3. **The attempt counter is PER ROW, written first, and capped.** A pass
 *     that crashes mid-flight still counts, so a row that makes the POST throw
 *     every time cannot spin forever. A row that lands clears its own counter.
 *     Per row rather than per blob because the counter has to distinguish
 *     "this row is poison" from "the session that owns this row has not been
 *     opened yet": one global counter let an undeliverable row for session A
 *     burn the budget and strand session B's message for ever, on a load where
 *     B's row was never even examined. At its cap a row is left in the blob and
 *     REPORTED — it is never deleted.
 *  4. **A migrated row asks the server to re-mint its wire id.** The id here is
 *     minted at page load, against a transcript this tab may not have read, for
 *     a message the user typed before their last reload. OpenCode reads an id
 *     that sorts below the transcript as already answered and never runs the
 *     turn, so placing it is the control plane's job at delivery time —
 *     `remintOnDelivery`.
 *
 * Attachments are not carried, because they were never in the blob: `strip()`
 * wrote `{ kind: 'lost' }` for every file, since a `File` cannot be
 * serialized. That loss happened on the user's last reload, not here;
 * `lostAttachments` carries the count so a caller can say so.
 */

import type {
  CreateSessionPromptResult,
  SessionPromptOverrides,
  SessionPromptPart,
} from '@kortix/sdk';

/**
 * Remove after this date: by then every active tab has run its single pass
 * (`MAX_MIGRATION_ATTEMPTS` per row, one pass per tab) and
 * `kortix_message_queue_v3` is unreadable by anything. Deleting earlier
 * strands a queue a user had when they last closed the tab before the inbox
 * deploy; leaving it makes permanent furniture of a one-deploy migration.
 * `queue-migration.test.ts` fails once the date passes, so the removal is
 * enforced by the suite rather than remembered.
 *
 * Files to delete then:
 *   - apps/web/src/features/session/queue-migration.ts (this file)
 *   - apps/web/src/features/session/queue-migration.test.ts
 *   - apps/web/src/features/session/queue-migration-runner.ts
 *   - apps/web/src/features/session/queue-migration-runner.test.ts
 *   plus the `runQueueMigration` effect in `session-chat.tsx`.
 */
export const QUEUE_MIGRATION_REMOVE_AFTER = '2026-11-01';

export const LEGACY_QUEUE_KEY = 'kortix_message_queue_v3';
export const MIGRATION_ATTEMPTS_KEY = 'kortix_message_queue_v3_migration_attempts';
export const MAX_MIGRATION_ATTEMPTS = 3;

export interface LegacyQueueRow {
  /** The key the old store filed this under — an OpenCode session id for a
   *  pre-inbox blob, a Kortix session id for one written by the boot shell. */
  sessionId: string;
  clientMessageId: string;
  text: string;
  agent?: string | null;
  model?: { providerID: string; modelID: string } | null;
  variant?: string | null;
  /** A `/` command entry. It has no inbox row shape — see `migrate` below. */
  command?: { name: string; split?: { before: string; after: string } };
  /** How many attachments the reload had already reduced to a marker. */
  lostAttachments?: number;
  createdAt: number;
}

function isModel(value: unknown): value is { providerID: string; modelID: string } {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.providerID === 'string' && typeof v.modelID === 'string';
}

function reviveCommand(value: unknown): LegacyQueueRow['command'] {
  if (!value || typeof value !== 'object') return undefined;
  const c = value as Record<string, unknown>;
  if (typeof c.name !== 'string' || !c.name) return undefined;
  const split = c.split as Record<string, unknown> | undefined;
  if (split && typeof split.before === 'string' && typeof split.after === 'string') {
    return { name: c.name, split: { before: split.before, after: split.after } };
  }
  return { name: c.name };
}

function reviveRow(sessionId: string, raw: unknown): LegacyQueueRow | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;
  const command = reviveCommand(m.command);
  // The same acceptance rule the old store used on reload: empty text is a
  // dead entry UNLESS it is an argument-less command, whose `text` is
  // legitimately ''.
  if (typeof m.text !== 'string' || (!m.text && !command)) return null;
  const clientMessageId =
    typeof m.clientMessageId === 'string'
      ? m.clientMessageId
      : typeof m.id === 'string'
        ? m.id
        : null;
  // No stable name means no idempotency key, and a row POSTed without one
  // duplicates itself on the next pass. There is nothing to recover here.
  if (!clientMessageId) return null;

  const lost = Array.isArray(m.files) ? m.files.length : 0;
  return {
    sessionId,
    clientMessageId,
    text: m.text,
    ...(command ? { command } : {}),
    ...(lost > 0 ? { lostAttachments: lost } : {}),
    // `null` and `undefined` stay distinct, exactly as the store kept them:
    // `undefined` means "resolve at send time", `null` means "send none".
    ...(typeof m.agent === 'string' ? { agent: m.agent } : m.agent === null ? { agent: null } : {}),
    ...(isModel(m.model) ? { model: m.model } : m.model === null ? { model: null } : {}),
    ...(typeof m.variant === 'string'
      ? { variant: m.variant }
      : m.variant === null
        ? { variant: null }
        : {}),
    createdAt: typeof m.createdAt === 'number' ? m.createdAt : 0,
  };
}

/**
 * Read the persisted v3 blob and flatten it to inbox rows, oldest first.
 *
 * Flattened across sessions rather than per session, because `createdAt` is the
 * only ordering anyone has and the user typed one sequence, not N.
 */
export function parseLegacyQueue(raw: string | null): LegacyQueueRow[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];

  const rows: LegacyQueueRow[] = [];
  for (const [sessionId, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue;
    const v = value as { pending?: unknown; failed?: unknown };
    for (const lane of [v.pending, v.failed]) {
      if (!Array.isArray(lane)) continue;
      for (const entry of lane) {
        const row = reviveRow(sessionId, entry);
        if (row) rows.push(row);
      }
    }
  }
  return rows.sort((a, b) => a.createdAt - b.createdAt);
}

/** Write rows back in the shape `parseLegacyQueue` reads. */
function serializeLegacyQueue(rows: LegacyQueueRow[]): string {
  const out: Record<string, { pending: unknown[]; failed: unknown[] }> = {};
  for (const row of rows) {
    const record = (out[row.sessionId] ??= { pending: [], failed: [] });
    const { sessionId: _sessionId, lostAttachments, ...rest } = row;
    record.pending.push({
      ...rest,
      id: row.clientMessageId,
      ...(lostAttachments ? { files: Array.from({ length: lostAttachments }, () => ({ kind: 'lost' })) } : {}),
    });
  }
  return JSON.stringify(out);
}

/**
 * The two ids one migrated row needs, which are NOT the same id.
 *
 * `sessionId` is the Kortix session id: the only one `POST .../prompts` takes.
 * `wireSessionId` is the OpenCode chat id: the only one the transcript — and
 * therefore the wire-id minter — is keyed by. Minting under the Kortix id
 * finds no transcript, so the mint's 2-minute clock backdate is never lifted
 * and the prompt can sort BELOW messages already on record, which OpenCode
 * reads as "already answered". Naming both, separately, is what stops the two
 * being confused at the call site.
 */
export interface MigrateTarget {
  projectId: string;
  sessionId: string;
  wireSessionId: string;
}

export interface MigrateDeps {
  read: (key: string) => string | null;
  write: (key: string, value: string) => void;
  remove: (key: string) => void;
  /**
   * Map a legacy queue key to the ids the inbox and the minter take.
   *
   * Not `projectIdFor`: the blob is keyed by whatever id the old store filed it
   * under, which for a pre-inbox blob is the OPENCODE session id — not the
   * Kortix session id the route uses. A caller that cannot map one returns
   * `null` and the row is kept.
   */
  resolve: (legacySessionId: string) => MigrateTarget | null;
  /** The wire `messageID` this prompt is POSTed under. Handed the whole
   *  target, so the OpenCode id and the Kortix id cannot be swapped here. */
  mintMessageId: (target: MigrateTarget) => string;
  enqueue: (
    projectId: string,
    sessionId: string,
    input: {
      clientMessageId: string;
      messageId: string;
      parts: SessionPromptPart[];
      overrides?: SessionPromptOverrides;
      remintOnDelivery?: boolean;
    },
  ) => Promise<CreateSessionPromptResult>;
  onError?: (message: string, cause?: unknown) => void;
}

export interface MigrateResult {
  migrated: number;
  /** POSTed and refused. Kept in the blob, retried on the next pass. */
  failed: number;
  /** Nothing to POST them to: an unmappable session, or a `/` command. Kept. */
  skipped: number;
  /** At `MAX_MIGRATION_ATTEMPTS` failed POSTs of its own. Kept and reported;
   *  no other row is held up by it. */
  stranded: number;
  cleared: boolean;
}

/** `clientMessageId` → how many passes have POSTed that row and failed. */
type MigrationAttempts = Record<string, number>;

function readAttempts(raw: string | null): MigrationAttempts {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Includes the pre-fix format, a bare count like `2`. It named no row, so
    // it cannot be attributed to one — and charging every row for it is the
    // bug that format had. Start clean.
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const out: MigrationAttempts = {};
  for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) out[id] = value;
  }
  return out;
}

function writeAttempts(deps: MigrateDeps, attempts: MigrationAttempts): void {
  if (Object.keys(attempts).length === 0) deps.remove(MIGRATION_ATTEMPTS_KEY);
  else deps.write(MIGRATION_ATTEMPTS_KEY, JSON.stringify(attempts));
}

/**
 * Move every recoverable row into the inbox, then clear the key.
 *
 * Sequential and awaited, never `Promise.all`: the inbox delivers by row age,
 * so a parallel flush would reorder the user's own messages.
 */
export async function migrateLegacyQueueToInbox(deps: MigrateDeps): Promise<MigrateResult> {
  const raw = deps.read(LEGACY_QUEUE_KEY);
  if (!raw) return { migrated: 0, failed: 0, skipped: 0, stranded: 0, cleared: false };

  const rows = parseLegacyQueue(raw);
  if (rows.length === 0) {
    // Junk, or an empty record left behind. There is nothing to lose.
    deps.remove(LEGACY_QUEUE_KEY);
    deps.remove(MIGRATION_ATTEMPTS_KEY);
    return { migrated: 0, failed: 0, skipped: 0, stranded: 0, cleared: true };
  }

  const attempts = readAttempts(deps.read(MIGRATION_ATTEMPTS_KEY));
  const kept: LegacyQueueRow[] = [];
  let migrated = 0;
  let failed = 0;
  let skipped = 0;
  let stranded = 0;

  for (const row of rows) {
    // A `/` command is dispatched by `runCommand`, never by `POST .../prompts`
    // — sent as text its arguments would go out as literal prose with no
    // command at all. Keeping it is the honest outcome: nothing is lost, and
    // nothing wrong is sent.
    const target = row.command ? null : deps.resolve(row.sessionId);
    if (!target) {
      // Not a failure, and it must not spend anything: several sessions are
      // mounted at once and each pass sees only its own rows.
      skipped += 1;
      kept.push(row);
      continue;
    }

    const priorFailures = attempts[row.clientMessageId] ?? 0;
    if (priorFailures >= MAX_MIGRATION_ATTEMPTS) {
      // This ROW is stuck. Every other row still gets its pass — a global cap
      // let one undeliverable message strand every other session's.
      stranded += 1;
      kept.push(row);
      deps.onError?.(
        `[queue-migration] ${row.clientMessageId} failed ${priorFailures} times; it is kept, not retried`,
      );
      continue;
    }

    const overrides: SessionPromptOverrides = {};
    if (row.agent !== undefined) overrides.agent = row.agent;
    if (row.model !== undefined) overrides.model = row.model;
    if (row.variant !== undefined) overrides.variant = row.variant;

    // BEFORE the POST. A counter written on the way out never increments for
    // the failure this cap exists to bound — a pass that does not return.
    attempts[row.clientMessageId] = priorFailures + 1;
    writeAttempts(deps, attempts);

    try {
      await deps.enqueue(target.projectId, target.sessionId, {
        clientMessageId: row.clientMessageId,
        // Minted under the OPENCODE chat id — the only id the transcript is
        // keyed by. Placed properly by the server before delivery all the
        // same: see `remintOnDelivery` below.
        messageId: deps.mintMessageId(target),
        parts: [{ type: 'text', text: row.text }],
        ...(Object.keys(overrides).length > 0 ? { overrides } : {}),
        // The id above is minted at page load, for a message typed before the
        // last reload, possibly before this tab has read a single transcript
        // message. Only the control plane can place it against the live root.
        remintOnDelivery: true,
      });
      migrated += 1;
      delete attempts[row.clientMessageId];
    } catch (cause) {
      failed += 1;
      kept.push(row);
      deps.onError?.(`[queue-migration] ${row.clientMessageId} could not be migrated`, cause);
    }
  }

  writeAttempts(deps, attempts);

  if (kept.length === 0) {
    deps.remove(LEGACY_QUEUE_KEY);
    return { migrated, failed, skipped, stranded, cleared: true };
  }

  // Only the leftovers. Rewriting the ones that landed is how a partial pass
  // becomes a loop — they would be deduped, but every pass would spend an
  // attempt on them.
  deps.write(LEGACY_QUEUE_KEY, serializeLegacyQueue(kept));
  return { migrated, failed, skipped, stranded, cleared: false };
}
