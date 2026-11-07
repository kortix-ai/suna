/**
 * Structured XML ref tags for every @-mention kind in the chat pipeline.
 *
 * Each block is a header line + one or more self-closing XML tags, appended
 * to the end of the outgoing message text. The agent sees structured
 * metadata, and the frontend strips every block back out of the rendered
 * bubble (see parse{Project,FileMention,AgentMention,Session}References in
 * session-chat.tsx).
 *
 * Shape is identical across kinds so the pattern stays uniform:
 *
 *   <user's text>
 *
 *   Referenced files (...):
 *   <file_ref path="..." name="..." />
 *
 *   Referenced agents (...):
 *   <agent_ref name="..." />
 *
 *   Referenced sessions (...):
 *   <session_ref id="..." title="..." />
 *
 *   Referenced Drive files (...):
 *   <drive_ref path="..." name="..." />
 */

// ─── Attribute escaping ─────────────────────────────────────────────────────

const XML_ATTR_ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '"': '&quot;',
  "'": '&#39;',
  '<': '&lt;',
  '>': '&gt;',
};

/**
 * Escape a value for a double-quoted XML attribute in ONE pass: `&`, `"`,
 * `'`, `<` and `>`. Values here often come from outside the user's own input
 * (an agent writes session titles), so the result can never close the
 * attribute or read as another tag. The inverse is `unescapeAttr` in
 * packages/ui/src/session/thread/message-parsing.tsx.
 */
export function escapeXmlAttr(value: string): string {
  return value.replace(/[&"'<>]/g, (ch) => XML_ATTR_ESCAPES[ch]!);
}

// ─── Types ──────────────────────────────────────────────────────────────────

export interface FileRefLike {
  /** Path inside the workspace, e.g. `src/foo.ts` or absolute. */
  path: string;
  /** Display name — defaults to path. */
  name?: string;
}

export interface AgentRefLike {
  name: string;
}

export interface SessionRefLike {
  id: string;
  title: string;
}

// ─── Tag builders ───────────────────────────────────────────────────────────

export function buildFileRef(f: FileRefLike): string {
  const name = f.name ?? f.path;
  return `<file_ref path="${escapeXmlAttr(f.path)}" name="${escapeXmlAttr(name)}" />`;
}

export function buildAgentRef(a: AgentRefLike): string {
  return `<agent_ref name="${escapeXmlAttr(a.name)}" />`;
}

/**
 * A file in the project's Drive: `path` is its Drive path (`/Company/a.png`),
 * not a sandbox path; `file` is the name of the upload that carries its bytes.
 */
export interface DriveRefLike {
  path: string;
  name: string;
  file: string;
}

export function buildDriveRef(d: DriveRefLike): string {
  return `<drive_ref path="${escapeXmlAttr(d.path)}" name="${escapeXmlAttr(d.name)}" file="${escapeXmlAttr(d.file)}" />`;
}

export function buildSessionRef(s: SessionRefLike): string {
  return `<session_ref id="${escapeXmlAttr(s.id)}" title="${escapeXmlAttr(s.title)}" />`;
}

// ─── Block builders ─────────────────────────────────────────────────────────

export function buildFileRefsBlock(files: ReadonlyArray<FileRefLike>): string {
  if (!files.length) return '';
  const refs = files.map(buildFileRef).join('\n');
  return `Referenced files (the user has explicitly @-mentioned these — read them if relevant):\n${refs}`;
}

export function buildAgentRefsBlock(agents: ReadonlyArray<AgentRefLike>): string {
  if (!agents.length) return '';
  const refs = agents.map(buildAgentRef).join('\n');
  return `Referenced agents (the user has @-mentioned these agents — delegate or hand off as appropriate):\n${refs}`;
}

/** The parenthesised hint `parseSessionReferences` strips with the header. */
export const SESSION_REFS_HINT = 'use the session_context tool to fetch details when needed';

export function buildSessionRefsBlock(sessions: ReadonlyArray<SessionRefLike>): string {
  if (!sessions.length) return '';
  const refs = sessions.map(buildSessionRef).join('\n');
  return `Referenced sessions (${SESSION_REFS_HINT}):\n${refs}`;
}

export function buildDriveRefsBlock(files: ReadonlyArray<DriveRefLike>): string {
  if (!files.length) return '';
  const refs = files.map(buildDriveRef).join('\n');
  return `Referenced Drive files (the user picked these from the project's Drive; each one is the attached upload named in its file attribute):\n${refs}`;
}

/** An attached file as `driveRefsOf` reads it: its upload name, and the Drive path it was staged from. */
export interface DriveUploadLike {
  name: string;
  drivePath?: string;
}

/**
 * One Drive ref per path, in mention order, for the paths whose upload rides
 * with this message. A chip whose file is not attached (still downloading,
 * refused, removed from the tray) gets no ref: the agent is never told of a
 * file it does not have.
 */
export function driveRefsOf(
  mentions: ReadonlyArray<MentionRefLike> | undefined,
  files: ReadonlyArray<DriveUploadLike>,
): DriveRefLike[] {
  const refs = new Map<string, DriveRefLike>();
  for (const mention of mentions ?? []) {
    if (mention.kind !== 'drive' || !mention.value || !mention.label || refs.has(mention.value)) continue;
    const upload = files.find((file) => file.drivePath === mention.value);
    if (upload) refs.set(mention.value, { path: mention.value, name: mention.label, file: upload.name });
  }
  return [...refs.values()];
}

/**
 * The Drive refs an edited message keeps: the ones whose `@name` is still in
 * the text and whose upload the edit kept. The edit sends those uploads again.
 */
export function keptDriveRefs(
  text: string,
  refs: ReadonlyArray<{ path: string; name: string; file?: string }>,
  keptFiles: ReadonlyArray<string>,
): DriveRefLike[] {
  return refs.flatMap((ref) =>
    ref.file && keptFiles.includes(ref.file) && text.includes(`@${ref.name}`) ? [{ path: ref.path, name: ref.name, file: ref.file }] : [],
  );
}

export function appendDriveRefs(text: string, files: ReadonlyArray<DriveRefLike>): string {
  const block = buildDriveRefsBlock(files);
  if (!block) return text;
  return `${text}\n\n${block}`;
}

// ─── Appenders (text-in, text-out) ──────────────────────────────────────────

export function appendFileRefs(text: string, files: ReadonlyArray<FileRefLike>): string {
  const block = buildFileRefsBlock(files);
  if (!block) return text;
  return `${text}\n\n${block}`;
}

export function appendAgentRefs(text: string, agents: ReadonlyArray<AgentRefLike>): string {
  const block = buildAgentRefsBlock(agents);
  if (!block) return text;
  return `${text}\n\n${block}`;
}

export function appendSessionRefs(text: string, sessions: ReadonlyArray<SessionRefLike>): string {
  const block = buildSessionRefsBlock(sessions);
  if (!block) return text;
  return `${text}\n\n${block}`;
}

/** One tracked `@` mention, as the composer collects it (`TrackedMention`). */
export interface MentionRefLike {
  kind: string;
  label: string;
  /** A session mention's session id; a Drive mention's Drive path. */
  value?: string;
}

/**
 * Append the reference blocks for a draft's `@` mentions: sessions, files,
 * Drive files, then agents, the order an in-session send writes them. The draft text holds
 * only `@label`, so without these blocks the agent gets no path to open and no
 * agent to hand off to. Used by every path that is not that send: a chat's
 * first message (`ComposerChatInput`) and a slash command's args
 * (`planDraftSubmission`).
 */
export function appendMentionRefs(
  text: string,
  mentions: ReadonlyArray<MentionRefLike> | undefined,
  /** The files the message carries: a Drive mention gets a ref only when its upload is among them. */
  files: ReadonlyArray<DriveUploadLike> = [],
): string {
  const labelled = (mentions ?? []).filter((mention) => mention.label);
  const sessions = labelled
    .filter((mention) => mention.kind === 'session' && mention.value)
    .map((mention) => ({ id: mention.value!, title: mention.label }));
  const workspaceFiles = labelled
    .filter((mention) => mention.kind === 'file')
    .map((mention) => ({ path: mention.label, name: mention.label }));
  const agents = labelled
    .filter((mention) => mention.kind === 'agent')
    .map((mention) => ({ name: mention.label }));
  return appendAgentRefs(appendDriveRefs(appendFileRefs(appendSessionRefs(text, sessions), workspaceFiles), driveRefsOf(labelled, files)), agents);
}
