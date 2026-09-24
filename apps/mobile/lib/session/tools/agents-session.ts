/**
 * Pure output parsers behind the `session_*` rows (web
 * `tool/tools/session-{get,list-background,message,read,search,lineage}-tool.tsx`).
 * Same regexes as web, lifted out of the components so they can be tested.
 */

/** Web: ids over 16 characters show as `…` + the last 12. */
export function shortSessionId(sessionId: string): string {
  return sessionId.length > 16 ? `…${sessionId.slice(-12)}` : sessionId;
}

// ─── session_get ─────────────────────────────────────────────────────────────

export interface ParsedSessionGetOutput {
  title: string;
  id: string;
  created: string;
  updated: string;
  changes: string;
  parent: string | null;
  todos: Array<{ status: string; text: string }>;
  msgCount: string;
  toolCount: string;
  compression: string | null;
  conversation: string;
  hasConversation: boolean;
}

export function parseSessionGetOutput(output: string, sid: string): ParsedSessionGetOutput | null {
  if (!output) return null;
  const titleMatch = output.match(/^=== SESSION:\s*(.+?)\s*===$/m);
  const idMatch = output.match(/^ID:\s*(ses_\S+)/m);
  const createdMatch = output.match(/Created:\s*(\S+ \S+)/);
  const updatedMatch = output.match(/Updated:\s*(\S+ \S+)/);
  const changesMatch = output.match(/^Changes:\s*(.+)/m);
  const parentMatch = output.match(/^Parent:\s*(ses_\S+)/m);

  const todosSection = output.match(/^Todos:\n([\s\S]*?)(?=\n(?:Lineage|Storage|===))/m);
  const todos: Array<{ status: string; text: string }> = [];
  if (todosSection) {
    for (const line of todosSection[1].split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed === '(none)') continue;
      const sm = trimmed.match(/^\[(\w+)\]\s*(.*)/);
      if (sm) todos.push({ status: sm[1], text: sm[2] });
      else todos.push({ status: 'pending', text: trimmed });
    }
  }

  const convHeader = output.match(/=== CONVERSATION \((.+?)\) ===/);
  const msgCount = convHeader?.[1]?.match(/(\d+) msgs?/)?.[1] || '0';
  const toolCount = convHeader?.[1]?.match(/(\d+) tool calls?/)?.[1] || '0';
  const compressionMatch = output.match(/=== COMPRESSION ===\n(.+)/m);

  const convStart = convHeader ? output.indexOf(convHeader[0]) + convHeader[0].length : -1;
  const convEnd = compressionMatch ? output.indexOf('=== COMPRESSION ===') : output.length;
  const conversation = convStart > 0 ? output.slice(convStart, convEnd).trim() : '';

  return {
    title: titleMatch?.[1] ?? 'Unknown Session',
    id: idMatch?.[1] ?? sid,
    created: createdMatch?.[1] ?? '',
    updated: updatedMatch?.[1] ?? '',
    changes: changesMatch?.[1] ?? '',
    parent: parentMatch?.[1] ?? null,
    todos,
    msgCount,
    toolCount,
    compression: compressionMatch?.[1]?.trim() ?? null,
    conversation,
    hasConversation: !!convHeader,
  };
}

export function sessionGetHeaderArgs(parsed: ParsedSessionGetOutput | null): string[] {
  const args: string[] = [];
  if (parsed?.hasConversation) args.push(`${parsed.msgCount} msgs`, `${parsed.toolCount} tools`);
  if (parsed?.compression) args.push('compressed');
  return args;
}

// ─── session_list ────────────────────────────────────────────────────────────

export interface BackgroundWorker {
  id: string;
  status: string;
  project: string;
  prompt: string;
}

export function parseBackgroundWorkers(output: string): BackgroundWorker[] {
  if (!output) return [];
  const entries: BackgroundWorker[] = [];
  const re = /\*\*(ses_\S+)\*\*.*?status:\s*(\w+).*?project:\s*(\S+)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(output)) !== null) {
    entries.push({ id: m[1], status: m[2], project: m[3], prompt: '' });
  }
  return entries;
}

export function sessionListArgs(workerCount: number, noWorkers: boolean): string[] {
  return workerCount > 0 ? [`${workerCount} workers`] : noWorkers ? ['none'] : [];
}

// ─── session_message ─────────────────────────────────────────────────────────

export function sessionMessageArgs(status: string): string[] {
  return status === 'completed' ? ['sent'] : status === 'error' ? ['failed'] : [];
}

// ─── session_read ────────────────────────────────────────────────────────────

export interface SessionReadSummary {
  status: string | null;
  agent: string | null;
  messages: string | null;
  toolCalls: string | null;
  toolList: string[];
}

export function sessionReadModeLabel(mode: string): 'tools' | 'full' | 'search' | 'summary' {
  return mode === 'tools' ? 'tools' : mode === 'full' ? 'full' : mode === 'search' ? 'search' : 'summary';
}

export function parseSessionReadSummary(output: string): SessionReadSummary | null {
  if (!output) return null;
  const statusM = output.match(/\*\*Status:\*\*\s*(\w+)/);
  const agentM = output.match(/\*\*Agent:\*\*\s*(\w+)/);
  const msgsM = output.match(/\*\*Messages:\*\*\s*(\d+)/);
  const toolsM = output.match(/\*\*Tool calls:\*\*\s*(\d+)/);
  const toolListM = output.match(/\*\*Tools:\*\*\s*(.+)/);
  return {
    status: statusM?.[1] || null,
    agent: agentM?.[1] || null,
    messages: msgsM?.[1] || null,
    toolCalls: toolsM?.[1] || null,
    toolList: toolListM?.[1]?.split(', ').map((t) => t.trim()) || [],
  };
}

export interface SessionReadToolEntry {
  /** Character offset of the match — a stable React key. */
  at: number;
  status: string;
  tool: string;
  summary: string;
}

export function parseSessionReadToolEntries(mode: string, output: string): SessionReadToolEntry[] {
  if (mode !== 'tools' || !output) return [];
  const entries: SessionReadToolEntry[] = [];
  const re = /^\[(\w+)\]\s+\*\*(\w+)\*\*:\s*(.+)/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(output)) !== null) {
    entries.push({ at: m.index, status: m[1], tool: m[2], summary: m[3].slice(0, 120) });
  }
  return entries;
}

export function sessionReadArgs(parsed: SessionReadSummary | null, mode: string, pattern: string): string[] {
  const args: string[] = [];
  if (parsed?.status) args.push(parsed.status);
  if (parsed?.messages) args.push(`${parsed.messages} msgs`);
  if (parsed?.toolCalls && parsed.toolCalls !== '0') args.push(`${parsed.toolCalls} tools`);
  if (mode === 'search' && pattern) args.push(`/${pattern}/`);
  return args;
}

// ─── session_search ──────────────────────────────────────────────────────────

export interface SessionSearchHit {
  id: string;
  title: string;
  updated: string;
  score: string;
  snippet: string;
}

export function parseSessionSearchHits(output: string): SessionSearchHit[] {
  if (!output) return [];
  const results: SessionSearchHit[] = [];
  const lines = output.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(ses_\S+)\s*\|\s*"([^"]*)"\s*\|\s*(\S+.*?)\s*\|\s*score=(\d+)/);
    if (m) {
      const snippetLine = lines[i + 1]?.match(/^Snippet:\s*(.+)/);
      results.push({
        id: m[1],
        title: m[2],
        updated: m[3].trim(),
        score: m[4],
        snippet: snippetLine?.[1]?.trim() || '',
      });
    }
  }
  return results;
}

// ─── session_lineage ─────────────────────────────────────────────────────────

export function countLineageSessions(output: string): number {
  if (!output) return 0;
  return (output.match(/ses_/g) || []).length;
}
