import type { ToolPart } from '@/lib/opencode/types';

// ─── Tool input resolver ─────────────────────────────────────────────────────
// The SDK sends `input` inside `state.input`, but mobile types define it at `tool.input`.
// At runtime the data may be in either location. This helper checks both.
// During pending/running state, tries to parse the streaming raw field for early labels.

function parsePartialJSON(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw);
  } catch {
    // Try closing open braces for partial JSON
    let patched = raw.trim();
    if (!patched.startsWith('{')) return {};
    // Close unclosed strings
    const quoteCount = (patched.match(/(?<!\\)"/g) || []).length;
    if (quoteCount % 2 !== 0) patched += '"';
    // Close any open braces
    const opens = (patched.match(/{/g) || []).length;
    const closes = (patched.match(/}/g) || []).length;
    for (let i = 0; i < opens - closes; i++) patched += '}';
    try {
      return JSON.parse(patched);
    } catch {
      return {};
    }
  }
}

export function getToolInput(tool: ToolPart): Record<string, any> {
  const stateInput = (tool.state as any)?.input;
  if (stateInput && typeof stateInput === 'object' && Object.keys(stateInput).length > 0) {
    return stateInput;
  }
  // During pending/running state, try to parse the streaming raw field
  if (
    (tool.state.status === 'pending' || tool.state.status === 'running') &&
    'raw' in (tool.state as any)
  ) {
    const raw = (tool.state as any).raw as string;
    if (raw) return parsePartialJSON(raw);
  }
  return tool.input || {};
}

// Tool rows animate (shimmer + spinner) only while their turn is working. A
// part left `pending`/`running` in stored history renders static.
export function isToolAnimating(tool: ToolPart, working: boolean): boolean {
  return working && (tool.state.status === 'pending' || tool.state.status === 'running');
}
