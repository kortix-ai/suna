/**
 * Pure logic behind the codemode script row (web `tool/tools/codemode-tool.tsx`).
 * A codemode call is a script the model wrote that calls the other tools; its
 * row lists those calls, so the decisions here parse pi's call record, name the
 * row by status, and summarize the calls the way web does.
 */

import { getToolPrimaryArg } from '@kortix/sdk';

/** One tool call a codemode script made. */
export interface CodemodeCall {
  id: string;
  name: string;
  /** The call's main argument (a command, a path), else its arguments as compact JSON. */
  arg: string;
  /** `refused`: the runtime blocked the call by design (the project policy, a person's reject, a tool scripts may not call). */
  status: 'running' | 'ok' | 'error' | 'refused' | 'cancelled';
  durationMs?: number;
  error?: string;
}

const STATUS: Record<string, CodemodeCall['status']> = {
  running: 'running',
  ok: 'ok',
  complete: 'ok',
  error: 'error',
  cancelled: 'cancelled',
  interrupted: 'cancelled',
};

/** The reasons the pi runtime blocks a call with (kortixd `pi/runtime.ts`: `decide`, `nestedCallGate`). */
const REFUSED =
  /^(The project policy denies|The user rejected|Call \S+ directly, not from a script)/;

/** The call's main argument, else its arguments as compact JSON; pi's live record sends truncated JSON that may not parse. */
export function codemodeCallArg(name: string, input: unknown): string {
  if (input === undefined || input === '') return '';
  let value = input;
  if (typeof input === 'string') {
    try {
      value = JSON.parse(input);
    } catch {
      return input;
    }
  }
  const primary =
    value && typeof value === 'object'
      ? getToolPrimaryArg({
          type: 'tool',
          tool: name,
          state: { status: 'completed', input: value },
        } as never)
      : '';
  return primary || (typeof value === 'string' ? value : JSON.stringify(value));
}

/**
 * The calls a script made, from its tool metadata: pi's live record while it runs
 * (`id`, `args` as JSON text, `ok`/`cancelled`) or the session log's at rest
 * (`call_id`, `input`, `complete`/`interrupted`).
 */
export function codemodeCalls(metadata: Record<string, unknown>): CodemodeCall[] {
  const calls = Array.isArray(metadata.calls)
    ? (metadata.calls as Array<Record<string, unknown>>)
    : [];
  return calls.map((c) => ({
    id: String(c.id ?? c.call_id ?? ''),
    name: String(c.name ?? ''),
    arg: codemodeCallArg(String(c.name ?? ''), c.args ?? c.input),
    status:
      STATUS[String(c.status)] === 'error' && typeof c.error === 'string' && REFUSED.test(c.error)
        ? 'refused'
        : (STATUS[String(c.status)] ?? 'cancelled'),
    ...(typeof (c.durationMs ?? c.duration_ms) === 'number'
      ? { durationMs: Number(c.durationMs ?? c.duration_ms) }
      : {}),
    ...(typeof c.error === 'string' && c.error ? { error: c.error } : {}),
  }));
}

/** The row's words: `Running script` live, `Script failed` on error, else `Ran script` — web's `tools.codemode` copy. */
export function codemodeTitle(status: string, running: boolean): string {
  if (running && status !== 'error' && status !== 'completed') return 'Running script';
  if (status === 'error') return 'Script failed';
  return 'Ran script';
}

/** Web's summary: the call count, then the distinct call names joined with ` · `. Empty with no calls. */
export function codemodeSummary(calls: readonly CodemodeCall[]): string {
  if (!calls.length) return '';
  const names = [...new Set(calls.map((c) => c.name))].join(' · ');
  const count = calls.length === 1 ? '1 tool call' : `${calls.length} tool calls`;
  return names ? `${count} · ${names}` : count;
}

/** The script's result without pi's `Script completed|failed`, `Wall time` and `Output:` header lines. */
export function codemodeResult(text: string): string {
  return text
    .replace(/^Script (?:completed|failed)\n(?:Wall time [^\n]*\n)?(?:Output:\n)?/, '')
    .trim();
}
