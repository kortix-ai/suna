import { createHash } from 'node:crypto';
import { digest } from './ledger';
import type { JsonRow } from './source';

type Part = JsonRow & { id: string; sessionID: string; messageID: string; type: string };
type Message = { info: JsonRow & { id: string }; parts: Part[] };

function object(value: unknown): JsonRow {
  if (typeof value === 'string') { try { return object(JSON.parse(value)); } catch { return { content: value }; } }
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRow : {};
}
function text(value: unknown): string {
  if (value == null) return '';
  return typeof value === 'string' ? value : JSON.stringify(value);
}
function timestamp(value: unknown): number {
  const at = typeof value === 'string' ? Date.parse(value) : NaN;
  if (!Number.isFinite(at)) throw new Error('Invalid source timestamp; refusing to replace it with migration time');
  return at;
}

/** A native runtime projection, plus an explicit disposition for every source row.
 * The raw ledger remains authoritative. Archival events are never claimed as native messages.
 */
export interface CapturedImage {
  mime: string;
  filename: string;
  base64: string;
  sha256: string;
}

export function projectThread(input: { ref: string; thread: JsonRow; project?: JsonRow; rows: JsonRow[]; runtimeVersion: string; attachments?: Record<string, CapturedImage> }) {
  if (input.project && input.project.project_id !== input.thread.project_id) throw new Error('Project does not belong to thread');
  const title = [input.thread.name, input.project?.name].find(value => typeof value === 'string' && value.trim()) as string | undefined;
  const threadId = String(input.thread.thread_id);
  const sessionID = `ses_${digest(JSON.stringify([input.ref, threadId])).slice(0, 26)}`;
  const rows = [...input.rows].sort((a, b) => timestamp(a.created_at) - timestamp(b.created_at) || String(a.message_id).localeCompare(String(b.message_id)));
  const messages: Message[] = [];
  const dispositions: Array<{ source_id: string; disposition: string; native_id?: string }> = [];
  const toolResults = new Map<string, JsonRow[]>();
  const toolParts = new Map<string, Part[]>();
  const messagesBySourceId = new Map<string, Message>();
  const unresolved: string[] = [];
  let lastUser = '';
  for (const row of rows) {
    const sourceId = String(row.message_id);
    if (row.type === 'tool') {
      const content = object(row.content);
      const call = text(content.tool_call_id ?? content.toolCallId);
      toolResults.set(call, [...(toolResults.get(call) ?? []), row]);
      continue;
    }
    if (!['user', 'assistant', 'summary'].includes(String(row.type))) {
      dispositions.push({ source_id: sourceId, disposition: 'raw-archive-event' });
      continue;
    }
    const at = timestamp(row.created_at);
    const id = `msg_${at.toString(16).padStart(12, '0')}${sourceId.replaceAll('-', '')}${digest(input.ref).slice(0, 8)}`;
    const user = row.type === 'user';
    if (user) lastUser = id;
    if (!user && !lastUser) unresolved.push(`assistant-without-user:${sourceId}`);
    const info = user
      ? { id, sessionID, role: 'user', time: { created: at }, agent: 'kortix', model: { providerID: 'legacy', modelID: 'unknown' } }
      : { id, sessionID, role: 'assistant', parentID: lastUser || id, time: { created: at, completed: at }, modelID: 'unknown', providerID: 'legacy', mode: 'kortix', agent: 'kortix', path: { cwd: '/workspace', root: '/workspace' }, cost: 0, tokens: { total: 0, input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, finish: 'stop' };
    const parts: Part[] = [];
    const add = (part: JsonRow & { type: string }) => {
      const full = { ...part, id: `prt_${at.toString(16).padStart(12, '0')}${sourceId.replaceAll('-', '')}${parts.length.toString(16).padStart(4, '0')}${digest(input.ref).slice(0, 8)}`, sessionID, messageID: id } as Part;
      parts.push(full); return full;
    };
    const content = object(row.content);
    if (Array.isArray(content.content)) {
      for (const block of content.content) {
        if (typeof block === 'string') { add({ type: 'text', text: block }); continue; }
        const item = object(block);
        const imageUrl = item.type === 'image_url' ? text(object(item.image_url).url) : '';
        const captured = imageUrl ? input.attachments?.[imageUrl] : undefined;
        if (typeof item.text === 'string') add({ type: 'text', text: item.text });
        else if (captured) {
          const bytes = Buffer.from(captured.base64, 'base64');
          if (!bytes.length || bytes.toString('base64') !== captured.base64 || createHash('sha256').update(bytes).digest('hex') !== captured.sha256) {
            throw new Error('Captured image digest or encoding mismatch');
          }
          if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(captured.mime)) throw new Error('Unsupported captured image MIME type');
          add({ type: 'file', mime: captured.mime, filename: captured.filename, url: `data:${captured.mime};base64,${captured.base64}` });
        } else {
          // Keep unknown and image blocks legible without inventing a working attachment URL.
          add({ type: 'text', text: `[Legacy content block]\n${JSON.stringify(block)}` });
          unresolved.push(`content-block:${sourceId}`);
        }
      }
    } else if (content.content != null) add({ type: 'text', text: text(content.content) });
    const metadata = object(row.metadata);
    const thinking = Array.isArray(content.thinking_blocks)
      ? content.thinking_blocks.map(b => text(object(b).thinking ?? object(b).text)).filter(Boolean).join('\n')
      : text(metadata.reasoning_content);
    if (thinking) add({ type: 'reasoning', text: thinking, time: { start: at, end: at } });
    for (const call of Array.isArray(content.tool_calls) ? content.tool_calls : []) {
      const tc = object(call); const fn = object(tc.function); const callId = text(tc.id);
      let args: unknown = fn.arguments ?? {};
      if (typeof args === 'string') { try { args = JSON.parse(args); } catch { unresolved.push(`tool-arguments:${sourceId}`); args = { legacy_arguments: args }; } }
      if (!args || typeof args !== 'object' || Array.isArray(args)) { unresolved.push(`tool-input-shape:${sourceId}`); args = { legacy_arguments: args }; }
      const part = add({ type: 'tool', callID: callId || `${sourceId}:${parts.length}`, tool: text(fn.name) || 'legacy_unknown', state: { status: 'error', input: args, error: 'Legacy tool result unavailable', time: { start: at, end: at } } });
      toolParts.set(callId, [...(toolParts.get(callId) ?? []), part]);
    }
    if (!parts.length && !user && content.role === 'assistant' && content.content === null) add({ type: 'text', text: '' });
    if (!parts.length) { add({ type: 'text', text: '[Legacy message has no runtime-compatible content; original record retained in archive.]' }); unresolved.push(`empty-content:${sourceId}`); }
    const message = { info, parts };messages.push(message);messagesBySourceId.set(sourceId,message);
    dispositions.push({ source_id: sourceId, disposition: 'native-message', native_id: id });
  }
  for (const [callId, results] of toolResults) {
    const parts = toolParts.get(callId) ?? [];
    if (callId && parts.length === 1 && results.length === 1) {
      const row = results[0]!; const part = parts[0]!; const state = object(part.state);
      part.state = { status: 'completed', input: state.input, output: text(object(row.content).content), title: part.tool, metadata: { legacy_source_message_id: row.message_id }, time: { start: object(state.time).start, end: timestamp(row.created_at) } };
      dispositions.push({ source_id: String(row.message_id), disposition: 'native-tool-result', native_id: part.id });
    } else {
      for (const row of results) {
        const sourceId=String(row.message_id),metadata=object(row.metadata),anchor=messagesBySourceId.get(text(metadata.assistant_message_id));
        const frontendExecution=object(object(metadata.frontend_content).tool_execution);
        const execution=frontendExecution.function_name&&frontendExecution.result!=null?frontendExecution:metadata;
        const argumentsValue=execution.arguments??{};
        if(anchor&&anchor.info.role==='assistant'&&text(execution.function_name)&&execution.result!=null&&argumentsValue&&typeof argumentsValue==='object'&&!Array.isArray(argumentsValue)){
          const at=timestamp(row.created_at),part={id:`prt_${at.toString(16).padStart(12,'0')}${sourceId.replaceAll('-','')}ffff${digest(input.ref).slice(0,8)}`,sessionID,messageID:anchor.info.id,type:'tool',callID:text(execution.tool_call_id)||`legacy-${sourceId}`,tool:text(execution.function_name),state:{status:'completed',input:argumentsValue,output:text(execution.result),title:text(execution.function_name),metadata:{legacy_source_message_id:sourceId,legacy_assistant_message_id:text(metadata.assistant_message_id),legacy_return_format:text(execution.return_format)},time:{start:at,end:at}}} as Part;
          anchor.parts.push(part);dispositions.push({source_id:sourceId,disposition:'native-tool-result-anchored',native_id:part.id});
        }else{dispositions.push({source_id:sourceId,disposition:'raw-archive-unmatched-tool'});unresolved.push(`ambiguous-tool-result:${sourceId}`);}
      }
    }
  }
  const created = input.thread.created_at ? timestamp(input.thread.created_at) : rows.length ? timestamp(rows[0]!.created_at) : 0;
  const updated = input.thread.updated_at ? timestamp(input.thread.updated_at) : rows.length ? timestamp(rows[rows.length - 1]!.created_at) : created;
  if (!created) throw new Error('Missing thread creation timestamp');
  if (new Set(rows.map(r => r.message_id)).size !== rows.length) throw new Error('Duplicate source message IDs');
  if (dispositions.length !== rows.length) throw new Error('Not every source row has a disposition');
  return {
    runtime: { info: { id: sessionID, slug: `legacy-${threadId}`, projectID: 'legacy', directory: '/workspace', title: title ?? 'Legacy conversation', version: input.runtimeVersion, time: { created, updated } }, messages },
    audit: { source_ref: input.ref, source_thread_id: threadId, source_rows: rows.length, native_messages: messages.length, dispositions, unresolved, raw_archive_required: true, billing_values_are_placeholders: true, ready_for_apply: false },
  };
}
