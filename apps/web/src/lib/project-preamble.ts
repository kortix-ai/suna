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
 */

// ─── Attribute escaping ─────────────────────────────────────────────────────

function escapeAttr(v: string): string {
  return v.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

/**
 * `escapeAttr` plus angle brackets, for values that come from outside the
 * user's own input (a session title is often written by an agent). The text
 * then cannot contain anything that reads as another tag. The inverse is
 * `unescapeAttr` in features/session/message-parsing.tsx.
 */
function escapeXmlAttr(v: string): string {
  return escapeAttr(v).replace(/</g, '&lt;').replace(/>/g, '&gt;');
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
  return `<file_ref path="${escapeAttr(f.path)}" name="${escapeAttr(name)}" />`;
}

export function buildAgentRef(a: AgentRefLike): string {
  return `<agent_ref name="${escapeAttr(a.name)}" />`;
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
