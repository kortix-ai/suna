/**
 * The header the API puts in front of a message that did not come from the
 * session's own person, so the agent knows who is speaking:
 *
 *   [MESSAGE from session <uuid> "Deploy pipeline" — sent by another agent, not by a person. Reply with `kortix send <uuid> "…"`.]
 *   [ASK from session <uuid> "Deploy pipeline" to Alice <alice@example.com> — …]
 *   [MESSAGE from Alice <alice@example.com>]
 *
 *   <message text>
 *
 * The API writes it (`sessionMessagePromptText`) from the authenticated caller,
 * never from client input. Web and mobile read it back
 * (`parseSessionMessagePrompt`) to strip the header from the bubble. Who wrote
 * a message is shown from the prompt ledger, not from this text.
 */

export type SessionMessageSender =
  | { kind: 'session'; sessionId: string; title: string }
  | { kind: 'person'; name: string; email: string };

export interface SessionMessagePerson {
  name: string;
  email: string;
}

export interface SessionMessagePromptInfo {
  /** `ask` opens a conversation with people; `message` is anything else. */
  type: 'message' | 'ask';
  sender: SessionMessageSender;
  /** The people an ask is addressed to. Empty for a message. */
  to: SessionMessagePerson[];
  /** The message text, without the header. */
  prompt: string;
}

/** Header fields are single-line and cannot close the header or a quote. */
function clean(value: string, max = 80): string {
  return value.replace(/[\r\n[\]"<>—]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function person(p: SessionMessagePerson): string {
  const name = clean(p.name) || clean(p.email);
  return `${name} <${clean(p.email, 254)}>`;
}

function sender(s: SessionMessageSender): string {
  return s.kind === 'session'
    ? `session ${s.sessionId} "${clean(s.title) || 'Untitled'}"`
    : person(s);
}

export function sessionMessagePromptText(input: SessionMessagePromptInfo): string {
  const from = sender(input.sender);
  const replyTo = input.sender.kind === 'session' ? input.sender.sessionId : null;
  let header: string;
  if (input.type === 'ask') {
    const to = input.to.map(person).join(', ');
    header = replyTo
      ? `[ASK from ${from} to ${to} — the agent that asked is not in this conversation. The people named answer here. When you have their answer, send it back with \`kortix send ${replyTo} "…"\`.]`
      : `[ASK from ${from} to ${to} — the people named answer here.]`;
  } else {
    header = replyTo
      ? `[MESSAGE from ${from} — sent by another agent, not by a person. Reply with \`kortix send ${replyTo} "…"\`.]`
      : `[MESSAGE from ${from}]`;
  }
  return `${header}\n\n${input.prompt}`;
}

const HEAD = /^\[(MESSAGE|ASK) from /;
const SESSION_SENDER = /^session ([0-9a-f-]{36}) "([^"]*)"/;
const PERSON = /^([^<\]]*?) <([^>\]]*)>/;

/** The header a prompt carries, or undefined for any other text. Linear time. */
export function parseSessionMessagePrompt(
  rawText: string | null | undefined,
): SessionMessagePromptInfo | undefined {
  if (!rawText) return undefined;
  const head = HEAD.exec(rawText);
  if (!head) return undefined;
  const lineEnd = rawText.indexOf('\n');
  const line = lineEnd < 0 ? rawText : rawText.slice(0, lineEnd);
  if (!line.endsWith(']')) return undefined;
  // Everything up to the instructions: the sender, then ` to <people>` on an ask.
  let rest = line.slice(head[0].length, -1).split(' — ')[0]!;
  const session = SESSION_SENDER.exec(rest);
  const personMatch = session ? null : PERSON.exec(rest);
  if (!session && !personMatch) return undefined;
  const sender: SessionMessageSender = session
    ? { kind: 'session', sessionId: session[1]!, title: session[2]! }
    : { kind: 'person', name: personMatch![1]!.trim(), email: personMatch![2]!.trim() };
  rest = rest.slice((session ?? personMatch)![0].length);
  const to: SessionMessagePerson[] = [];
  if (rest.startsWith(' to ')) {
    for (const piece of rest.slice(4).split(', ')) {
      const m = PERSON.exec(piece);
      if (m) to.push({ name: m[1]!.trim(), email: m[2]!.trim() });
    }
  }
  return {
    type: head[1] === 'ASK' ? 'ask' : 'message',
    sender,
    to,
    prompt: (lineEnd < 0 ? '' : rawText.slice(lineEnd + 1)).trim(),
  };
}
