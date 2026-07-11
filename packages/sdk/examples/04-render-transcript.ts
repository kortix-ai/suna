/**
 * 04 — Render a session's transcript as plain text, no React.
 *
 * `classifyTurn` (`@kortix/sdk/turns`) is framework-free: it normalizes every
 * opencode part type (text, reasoning, tool, file, subtask, patch, snapshot,
 * agent, retry, compaction, step) into a `ClassifiedPart` with a
 * compile-time-exhaustive `kind`, plus a normalized `TurnError` for a failed
 * assistant turn. This is the exact same classification
 * `apps/whitelabel-demo/src/components/chat/message-view.tsx` uses to render
 * React — here we switch over `part.kind` and print plain text instead, to
 * show the classification itself has no framework dependency.
 *
 * Run:
 *   KORTIX_API_URL=http://localhost:8008/v1 KORTIX_API_KEY=kortix_pat_... \
 *   KORTIX_PROJECT_ID=... KORTIX_SESSION_ID=... \
 *     bun run examples/04-render-transcript.ts
 *
 * As an npm consumer:
 *   import { createKortix } from '@kortix/sdk';
 *   import { classifyTurn, type ClassifiedPart } from '@kortix/sdk/turns';
 */
import { createKortix } from '../src/index';
import { classifyTurn, type ClassifiedPart } from '../src/turns/index';
import type { MessageWithParts } from '../src/transcript';

function renderPart(part: ClassifiedPart): string {
  switch (part.kind) {
    case 'text':
      return part.text;
    case 'reasoning':
      return `  (thinking: ${part.text})`;
    case 'tool':
      return `  [tool: ${part.tool.name} — ${part.tool.status}]`;
    case 'file':
      return `  [attachment: ${part.filename ?? part.url}]`;
    case 'subtask':
      return `  [delegated to ${part.agent}${part.description ? `: ${part.description}` : ''}]`;
    case 'patch':
      return `  [${part.fileCount} file(s) changed]`;
    case 'retry':
      return `  [retry attempt ${part.attempt}: ${part.message}]`;
    case 'compaction':
      return `  [context compacted${part.auto ? ' (auto)' : ''}]`;
    // snapshot/agent/step carry no chat-visible content of their own — same
    // deliberate no-op as message-view.tsx's renderers for these kinds.
    case 'snapshot':
    case 'agent':
    case 'step':
      return '';
    default:
      return `  [unrecognized part kind]`;
  }
}

async function main() {
  const backendUrl = process.env.KORTIX_API_URL ?? 'http://localhost:8008/v1';
  const apiKey = process.env.KORTIX_API_KEY;
  const projectId = process.env.KORTIX_PROJECT_ID;
  const sessionId = process.env.KORTIX_SESSION_ID;

  if (!apiKey || !projectId || !sessionId) {
    console.error('Set KORTIX_API_KEY, KORTIX_PROJECT_ID, and KORTIX_SESSION_ID and re-run.');
    process.exit(1);
  }

  const kortix = createKortix({ backendUrl, getToken: async () => apiKey });
  const session = kortix.session(projectId, sessionId);
  const { opencodeSessionId } = await session.ensureReady();
  if (!opencodeSessionId) {
    throw new Error('This legacy OpenCode transcript example does not apply to an ACP session.');
  }

  const result = await session.runtime.session.messages({ sessionID: opencodeSessionId });
  const messages = (result.data ?? []) as MessageWithParts[];

  for (const message of messages) {
    const { parts, error, isEmpty } = classifyTurn(message);
    console.log(`\n## ${message.info.role}`);
    if (isEmpty && !error) continue;
    for (const part of parts) {
      const rendered = renderPart(part);
      if (rendered) console.log(rendered);
    }
    if (error) console.log(`  [error: ${error.name} — ${error.message}]`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
