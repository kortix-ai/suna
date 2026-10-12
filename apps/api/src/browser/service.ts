/**
 * Kortix Browser services. Plain values in, plain values out: no Hono Context.
 * The routes (routes.ts) and the control socket (ws.ts) call these.
 */
import {
  BrowserError,
  CONSENT_POLL_MS,
  CONSENT_TIMEOUT_MS,
  decideConsent,
  isConsentDecision,
  isStopReason,
  pickBrowser,
  toBrowserDto,
  type BrowserDto,
  type BrowserRow,
} from './logic';
import { closeBrowser, sendToBrowser } from './registry';
import {
  activeSessionsFor,
  getAttachment,
  getBrowser,
  insertAttachment,
  listBrowsers,
  listGrants,
  loadSessionContext,
  openAttachmentIdsOfBrowser,
  openAttachmentsOfSession,
  replaceSessionGrant,
  revokeBrowser,
  setAttachmentStatus,
  updateBrowser,
} from './store';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function dtoFor(row: BrowserRow): Promise<BrowserDto> {
  const sessions = await activeSessionsFor([row.browserId]);
  return toBrowserDto(row, sessions.get(row.browserId) ?? []);
}

// ── User routes ─────────────────────────────────────────────────────────────

export async function listBrowserDtos(userId: string): Promise<BrowserDto[]> {
  const rows = await listBrowsers(userId);
  const sessions = await activeSessionsFor(rows.map((r) => r.browserId));
  return rows.map((r) => toBrowserDto(r, sessions.get(r.browserId) ?? []));
}

/** Update a browser and push the new state to the extension. Null: not the caller's. */
export async function patchBrowser(
  userId: string,
  browserId: string,
  patch: { name?: string; accessMode?: string; tabScope?: string },
): Promise<BrowserDto | null> {
  const row = Object.keys(patch).length ? await updateBrowser(userId, browserId, patch) : await getBrowser(userId, browserId);
  if (!row) return null;
  const dto = await dtoFor(row);
  await sendToBrowser(browserId, { type: 'browser', browser: dto });
  return dto;
}

/** Revoke a browser: tell its extension to detach, then close the control socket. */
export async function deleteBrowser(userId: string, browserId: string): Promise<boolean> {
  const open = await openAttachmentIdsOfBrowser(browserId);
  if (!(await revokeBrowser(userId, browserId))) return false;
  for (const attachmentId of open) await sendToBrowser(browserId, { type: 'detach', attachmentId });
  await closeBrowser(browserId, 4003, 'browser disconnected from Kortix');
  return true;
}

// ── Sandbox routes ──────────────────────────────────────────────────────────

export interface AttachInput {
  userId: string;
  sessionId: string;
  projectId: string;
  browser?: string;
  ticket: string;
  ask: boolean;
}

/** Attach a session to one of the owner's browsers. Throws `BrowserError`. */
export async function attachBrowser(input: AttachInput): Promise<{ attachmentId: string; browser: BrowserDto }> {
  const row = pickBrowser(await listBrowsers(input.userId), input.browser);
  const grants = await listGrants(row.browserId, input.projectId, input.sessionId);
  const outcome = decideConsent({
    accessMode: row.accessMode,
    grants,
    sessionId: input.sessionId,
    projectId: input.projectId,
    ask: input.ask,
  });
  const attachment = await insertAttachment({
    browserId: row.browserId,
    userId: input.userId,
    projectId: input.projectId,
    sessionId: input.sessionId,
    status: outcome === 'granted' ? 'granted' : 'pending',
  });
  await endSupersededAttachments(input.sessionId, attachment.attachmentId);

  const context = await loadSessionContext(input.sessionId, input.projectId);
  await sendToBrowser(row.browserId, {
    type: 'attach',
    attachmentId: attachment.attachmentId,
    sessionId: input.sessionId,
    sessionTitle: context.title,
    projectId: input.projectId,
    projectName: context.projectName,
    bridgePath: `/v1/p/${context.externalId ?? input.sessionId}/8000/kortix/browser/bridge?ticket=${input.ticket}`,
    ticket: input.ticket,
    consent: outcome === 'ask',
  });

  if (outcome === 'ask') await waitForConsent(attachment.attachmentId, row.browserId);
  const fresh = (await getBrowser(input.userId, row.browserId)) ?? row;
  return { attachmentId: attachment.attachmentId, browser: await dtoFor(fresh) };
}

/** A new attach replaces the session's earlier ones. The new bridge dial replaces the old bridge. */
async function endSupersededAttachments(sessionId: string, keepId: string): Promise<void> {
  for (const old of await openAttachmentsOfSession(sessionId, keepId)) {
    await setAttachmentStatus(old.attachmentId, 'ended', ['pending', 'granted', 'connected'], 'replaced');
    await sendToBrowser(old.browserId, { type: 'detach', attachmentId: old.attachmentId });
  }
}

/** Poll the attachment row until the person answers in Chrome. */
async function waitForConsent(attachmentId: string, browserId: string): Promise<void> {
  const deadline = Date.now() + CONSENT_TIMEOUT_MS;
  for (;;) {
    const row = await getAttachment(attachmentId);
    if (row?.status === 'granted' || row?.status === 'connected') return;
    if (!row || row.status !== 'pending') throw new BrowserError('browser_denied');
    if (Date.now() >= deadline) break;
    await sleep(CONSENT_POLL_MS);
  }
  await setAttachmentStatus(attachmentId, 'failed', ['pending'], 'consent_timeout');
  await sendToBrowser(browserId, { type: 'detach', attachmentId });
  throw new BrowserError('browser_consent_timeout');
}

/** The session releases its browser. Unknown or foreign attachments are a no-op. */
export async function releaseBrowser(input: { sessionId: string; attachmentId: string }): Promise<void> {
  const row = await getAttachment(input.attachmentId);
  if (!row || row.sessionId !== input.sessionId) return;
  await setAttachmentStatus(row.attachmentId, 'ended', ['pending', 'granted', 'connected'], 'released');
  await sendToBrowser(row.browserId, { type: 'detach', attachmentId: row.attachmentId });
}

// ── Frames from the extension ───────────────────────────────────────────────

/** The extension answers a consent prompt. */
export async function handleConsent(browserId: string, attachmentId: string, decision: unknown): Promise<void> {
  const row = await getAttachment(attachmentId);
  if (!row || row.browserId !== browserId || row.status !== 'pending' || !isConsentDecision(decision)) return;
  const projectId = row.projectId ?? '';
  const grant = { browserId, projectId, sessionId: row.sessionId };
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
export async function handleAttached(browserId: string, attachmentId: string): Promise<void> {
  const row = await getAttachment(attachmentId);
  if (!row || row.browserId !== browserId) return;
  await setAttachmentStatus(attachmentId, 'connected', ['granted', 'connected']);
}

/** The extension dropped an attachment. Stop and cancel also deny the session and abort its turn. */
export async function handleDetached(browserId: string, attachmentId: string, reason: unknown): Promise<void> {
  const row = await getAttachment(attachmentId);
  if (!row || row.browserId !== browserId) return;
  const ended = await setAttachmentStatus(
    attachmentId,
    'ended',
    ['pending', 'granted', 'connected'],
    typeof reason === 'string' ? reason.slice(0, 64) : null,
  );
  if (!ended || !isStopReason(reason)) return;
  await replaceSessionGrant({
    browserId,
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
