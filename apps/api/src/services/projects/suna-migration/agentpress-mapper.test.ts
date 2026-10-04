import { describe, test, expect } from 'bun:test';
import { normalizeAgentpressThread, type AgentpressMessageRow } from './agentpress-mapper';

// Rows shaped exactly like real public.messages content (OpenAI format).
function row(type: string, content: unknown, ms: number, isLlm = true): AgentpressMessageRow {
  return { message_id: `m${ms}`, type, is_llm_message: isLlm, content, created_at: new Date(ms).toISOString() };
}

describe('normalizeAgentpressThread', () => {
  test('user → assistant(text+tool) → tool-result folds into the tool part', () => {
    const rows: AgentpressMessageRow[] = [
      row('user', { role: 'user', content: 'Em uma apresentação para mostrar Anatomia' }, 1),
      row('assistant', {
        role: 'assistant',
        content: 'Perfeito! Vou entregar a apresentação:',
        tool_calls: [{ id: 'tooluse_3X', type: 'function', function: { name: 'complete', arguments: '{"text":"pronto"}' } }],
      }, 2),
      row('tool', { name: 'complete', role: 'tool', content: '{"status":"complete"}', tool_call_id: 'tooluse_3X' }, 3),
    ];

    const out = normalizeAgentpressThread(rows);

    expect(out).toHaveLength(2); // user + assistant (tool-result folded in)
    expect(out[0]).toMatchObject({ role: 'user', parts: [{ type: 'text', text: 'Em uma apresentação para mostrar Anatomia' }] });

    const asst = out[1];
    expect(asst.role).toBe('assistant');
    expect(asst.parts[0]).toEqual({ type: 'text', text: 'Perfeito! Vou entregar a apresentação:' });
    expect(asst.parts[1]).toEqual({
      type: 'tool',
      callId: 'tooluse_3X',
      name: 'complete',
      input: { text: 'pronto' },          // arguments JSON parsed
      output: '{"status":"complete"}',    // folded from the tool row
    });
  });

  test('drops ephemeral agentpress runtime rows (status / response markers)', () => {
    const rows: AgentpressMessageRow[] = [
      row('status', { k: 'thinking' }, 1, false),
      row('llm_response_start', {}, 2, false),
      row('user', { role: 'user', content: 'hi' }, 3),
      row('llm_response_end', {}, 4, false),
      row('browser_state', { url: 'x' }, 5, false),
    ];
    const out = normalizeAgentpressThread(rows);
    expect(out).toHaveLength(1);
    expect(out[0].role).toBe('user');
  });

  test('stringified content + array content blocks are handled', () => {
    const rows: AgentpressMessageRow[] = [
      row('user', '{"role":"user","content":"stringified"}', 1),                       // content is a JSON string
      row('assistant', { role: 'assistant', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }, 2),
    ];
    const out = normalizeAgentpressThread(rows);
    expect(out[0].parts[0]).toEqual({ type: 'text', text: 'stringified' });
    expect(out[1].parts[0]).toEqual({ type: 'text', text: 'ab' });
  });

  test('unanswered tool call keeps output null (sandbox cut off mid-run)', () => {
    const rows: AgentpressMessageRow[] = [
      row('assistant', { role: 'assistant', content: '', tool_calls: [{ id: 't1', type: 'function', function: { name: 'edit', arguments: '{}' } }] }, 1),
    ];
    const out = normalizeAgentpressThread(rows);
    expect(out[0].parts[0]).toMatchObject({ type: 'tool', callId: 't1', output: null });
  });
});
