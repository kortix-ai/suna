#!/usr/bin/env bun
/**
 * telegram — the in-sandbox CLI for Telegram-originated sessions.
 *
 * Thin turn-stream shim, NO TOKEN in the sandbox: `step` and `send` relay
 * through the Kortix API (/projects/:id/turn-stream), which owns the live
 * status message in the chat and holds the bot token server-side. Richer
 * Telegram calls (send_document, get_file, get_chat…) go through the executor
 * gateway's `kortix_telegram` connector — also token-free from in here.
 *
 *   telegram step "Reading the logs"        → advances the live checklist
 *   telegram send "All done — summary…"     → final answer (markdown ok)
 */
import { handleError, kortixPost, kortixProjectId, kortixSessionId, out, parseArgs } from '../lib';

async function relayTurnStream(kind: 'step' | 'answer', text: string): Promise<boolean> {
  const projectId = kortixProjectId();
  const sessionId = kortixSessionId();
  if (!projectId || !sessionId) return false;
  try {
    const r = await kortixPost<{ ok?: boolean }>(`/projects/${projectId}/turn-stream`, {
      session_id: sessionId,
      kind,
      text,
    });
    return r?.ok === true;
  } catch {
    return false;
  }
}

const HELP = `telegram — talk back to the Telegram chat that started this session.

Usage:
  telegram step "Short progress checkpoint"   Update the live status message.
  telegram send "Final answer"                Deliver the answer (markdown ok:
                                              **bold**, *italic*, \`code\`,
                                              fenced blocks, [links](https://…)).
  telegram help                               This help.

No token needed — everything relays through Kortix; the bot token stays
server-side. One \`telegram send\` per turn: it finalizes the live message.
For files and chat metadata use the executor connector actions
(kortix_telegram: send_document, get_file, get_chat).`;

async function main() {
  const { command, args } = parseArgs(process.argv);
  const text = args.join(' ').trim();

  switch (command) {
    case 'step': {
      if (!text) return out({ ok: false, error: 'usage: telegram step "progress text"' });
      return out({ ok: await relayTurnStream('step', text) });
    }
    case 'send': {
      if (!text) return out({ ok: false, error: 'usage: telegram send "final answer"' });
      return out({ ok: await relayTurnStream('answer', text) });
    }
    default: {
      console.log(HELP);
    }
  }
}

main().catch(handleError);
