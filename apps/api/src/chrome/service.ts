/**
 * Kortix for Chrome services. Plain values in, plain values out: no Hono Context.
 * The routes (routes.ts) and the control socket (ws.ts) call these.
 */
import {
  ChromeError,
  CONSENT_POLL_MS,
  CONSENT_TIMEOUT_MS,
  decideConsent,
  isConsentDecision,
  isStopReason,
  pickChrome,
  toChromeDto,
  type ChromeDto,
  type ChromeRow,
} from './logic';
import { closeChrome, sendToChrome } from './registry';
import {
  activeSessionsFor,
  getAttachment,
  getChrome,
  insertAttachment,
  listChromeConnections,
  listGrants,
  loadSessionContext,
  openAttachmentIdsOfChrome,
  openAttachmentsOfSession,
  replaceSessionGrant,
  revokeChrome,
  setAttachmentStatus,
  updateChromeConnection,
} from './store';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function dtoFor(row: ChromeRow): Promise<ChromeDto> {
  const sessions = await activeSessionsFor([row.chromeId]);
  return toChromeDto(row, sessions.get(row.chromeId) ?? []);
}

// ── User routes ─────────────────────────────────────────────────────────────

export async function listChromeConnectionDtos(userId: string): Promise<ChromeDto[]> {
  const rows = await listChromeConnections(userId);
  const sessions = await activeSessionsFor(rows.map((r) => r.chromeId));
  return rows.map((r) => toChromeDto(r, sessions.get(r.chromeId) ?? []));
}

/** Update a browser and push the new state to the extension. Null: not the caller's. */
export async function patchChrome(
  userId: string,
  chromeId: string,
  patch: { name?: string; accessMode?: string; tabScope?: string },
): Promise<ChromeDto | null> {
  const row = Object.keys(patch).length ? await updateChromeConnection(userId, chromeId, patch) : await getChrome(userId, chromeId);
  if (!row) return null;
  const dto = await dtoFor(row);
  await sendToChrome(chromeId, { type: 'chrome', chrome: dto });
  return dto;
}

/** Revoke a chrome: tell its extension to detach, then close the control socket. */
export async function deleteChromeConnection(userId: string, chromeId: string): Promise<boolean> {
  const open = await openAttachmentIdsOfChrome(chromeId);
  if (!(await revokeChrome(userId, chromeId))) return false;
  for (const attachmentId of open) await sendToChrome(chromeId, { type: 'detach', attachmentId });
  await closeChrome(chromeId, 4003, 'browser disconnected from Kortix');
  return true;
}

// ── Sandbox routes ──────────────────────────────────────────────────────────

export interface AttachInput {
  userId: string;
  sessionId: string;
  projectId: string;
  chrome?: string;
  ticket: string;
  ask: boolean;
}

/** Attach a session to one of the owner's browsers. Throws `ChromeError`. */
export async function attachChrome(input: AttachInput): Promise<{ attachmentId: string; chrome: ChromeDto }> {
  const row = pickChrome(await listChromeConnections(input.userId), input.chrome);
  const grants = await listGrants(row.chromeId, input.projectId, input.sessionId);
  const outcome = decideConsent({
    accessMode: row.accessMode,
    grants,
    sessionId: input.sessionId,
    projectId: input.projectId,
    ask: input.ask,
  });
  const attachment = await insertAttachment({
    chromeId: row.chromeId,
    userId: input.userId,
    projectId: input.projectId,
    sessionId: input.sessionId,
    status: outcome === 'granted' ? 'granted' : 'pending',
  });
  await endSupersededAttachments(input.sessionId, attachment.attachmentId);

  const context = await loadSessionContext(input.sessionId, input.projectId);
  await sendToChrome(row.chromeId, {
    type: 'attach',
    attachmentId: attachment.attachmentId,
    sessionId: input.sessionId,
    sessionTitle: context.title,
    projectId: input.projectId,
    projectName: context.projectName,
    bridgePath: `/v1/p/${context.externalId ?? input.sessionId}/8000/kortix/chrome/bridge?ticket=${input.ticket}`,
    ticket: input.ticket,
    consent: outcome === 'ask',
  });

  if (outcome === 'ask') await waitForConsent(attachment.attachmentId, row.chromeId);
  const fresh = (await getChrome(input.userId, row.chromeId)) ?? row;
  return { attachmentId: attachment.attachmentId, chrome: await dtoFor(fresh) };
}

/** A new attach replaces the session's earlier ones. The new bridge dial replaces the old bridge. */
async function endSupersededAttachments(sessionId: string, keepId: string): Promise<void> {
  for (const old of await openAttachmentsOfSession(sessionId, keepId)) {
    await setAttachmentStatus(old.attachmentId, 'ended', ['pending', 'granted', 'connected'], 'replaced');
    await sendToChrome(old.chromeId, { type: 'detach', attachmentId: old.attachmentId });
  }
}

/** Poll the attachment row until the person answers in Chrome. */
async function waitForConsent(attachmentId: string, chromeId: string): Promise<void> {
  const deadline = Date.now() + CONSENT_TIMEOUT_MS;
  for (;;) {
    const row = await getAttachment(attachmentId);
    if (row?.status === 'granted' || row?.status === 'connected') return;
    if (!row || row.status !== 'pending') throw new ChromeError('chrome_denied');
    if (Date.now() >= deadline) break;
    await sleep(CONSENT_POLL_MS);
  }
  await setAttachmentStatus(attachmentId, 'failed', ['pending'], 'consent_timeout');
  await sendToChrome(chromeId, { type: 'detach', attachmentId });
  throw new ChromeError('chrome_consent_timeout');
}

/** The session releases its browser. Unknown or foreign attachments are a no-op. */
export async function releaseChrome(input: { sessionId: string; attachmentId: string }): Promise<void> {
  const row = await getAttachment(input.attachmentId);
  if (!row || row.sessionId !== input.sessionId) return;
  await setAttachmentStatus(row.attachmentId, 'ended', ['pending', 'granted', 'connected'], 'released');
  await sendToChrome(row.chromeId, { type: 'detach', attachmentId: row.attachmentId });
}

// ── Frames from the extension ───────────────────────────────────────────────

/** The extension answers a consent prompt. */
export async function handleConsent(chromeId: string, attachmentId: string, decision: unknown): Promise<void> {
  const row = await getAttachment(attachmentId);
  if (!row || row.chromeId !== chromeId || row.status !== 'pending' || !isConsentDecision(decision)) return;
  const projectId = row.projectId ?? '';
  const grant = { chromeId, projectId, sessionId: row.sessionId };
  if (decision === 'deny') {
    await replaceSessionGrant({ ...grant, grantSessionId: row.sessionId, decision: 'deny' });
    await setAttachmentStatus(attachmentId, 'denied', ['pending'], 'denied_by_user');
    return;
  }
  await replaceSessionGrant({
    ...grant,
    grantSessionId: decision === 'session' ? row.sessionId : null,
    decision: 'allow',
  });
  await setAttachmentStatus(attachmentId, 'granted', ['pending']);
}

/** The bridge socket opened. */
export async function handleAttached(chromeId: string, attachmentId: string): Promise<void> {
  const row = await getAttachment(attachmentId);
  if (!row || row.chromeId !== chromeId) return;
  await setAttachmentStatus(attachmentId, 'connected', ['granted', 'connected']);
}

/** The extension dropped an attachment. Stop and cancel also deny the session and abort its turn. */
export async function handleDetached(chromeId: string, attachmentId: string, reason: unknown): Promise<void> {
  const row = await getAttachment(attachmentId);
  if (!row || row.chromeId !== chromeId) return;
  const ended = await setAttachmentStatus(
    attachmentId,
    'ended',
    ['pending', 'granted', 'connected'],
    typeof reason === 'string' ? reason.slice(0, 64) : null,
  );
  if (!ended || !isStopReason(reason)) return;
  await replaceSessionGrant({
    chromeId,
    projectId: row.projectId ?? '',
    sessionId: row.sessionId,
    grantSessionId: row.sessionId,
    decision: 'deny',
  });
  try {
    const { abortRuntimeTurn } = await import('../projects/surface');
    await abortRuntimeTurn(row.sessionId, { requestedStop: true });
  } catch {
    // Best effort: the deny grant already stops the next attach.
  }
}
