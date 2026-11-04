/**
 * The front chat (flag `infinichat`): one endless chat in which the person only
 * talks. The front session has three tools (`agent`, `send_message`,
 * `task_stop`) and passes everything to one standing worker, a My Kortix
 * session named `kortix` that does the work with every tool. The person sees
 * messages back and forth, never the work.
 *
 * The API marks a front session with `kortix.front` in its runtime_context
 * (`FRONT_CONTEXT_KEY`); a person cannot set that key.
 */

/** The only tools a front session has. */
export const FRONT_TOOLS: readonly string[] = ['agent', 'send_message', 'task_stop']

/** The name of the front's one worker session: what `send_message` addresses. */
export const FRONT_WORKER_NAME = 'kortix'
/** The worker's agent: My Kortix, with every tool. */
export const FRONT_WORKER_AGENT = 'mykortix'

/** Added to every task the front hands its worker: the answer reaches the chat once, as the run's report. */
export const FRONT_WORKER_NOTE =
  'Your final answer goes back to the person\'s chat by itself. Never send_message the chat that started you; end with the answer instead.'

/**
 * A thread's name from the model's `name`, else from its `description`: what
 * `agent({ name })` continues and `send_message` addresses.
 */
export function frontThreadName(name: unknown, description: string): string {
  const raw = typeof name === 'string' && name.trim() ? name : description
  const slug = raw.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
  return slug || FRONT_WORKER_NAME
}

export const FRONT_PROMPT = [
  'You are Kortix, the one chat the person talks to. You never do the work yourself: you have no tools to read, search, run or change anything. Threads do the work: each is a colleague with every tool, every connector and the person\'s access, and many run at once. The person sees every thread beside this chat and can open one.',
  '',
  '## One thread per task',
  '- A new task: call `agent` with a short `name` for the thread (letters, digits, "-", such as "crm-research"), a short `description`, and the person\'s words as `prompt`, plus any context from this chat it needs. Several tasks in one message: one `agent` call per task, in the same turn.',
  '- A follow-up, answer or correction for an existing thread: call `agent` with that thread\'s `name`. It continues the thread with everything it already knows. When that call says the thread is still working: `send_message` to its name with the person\'s words and `notify_when_idle: true`.',
  '- Pass the person\'s words on whole, never a summary that drops a detail. When a call fails, tell the person in one line what failed.',
  '- "Stop" or "cancel": `task_stop` on that thread.',
  '- Every message that asks for anything starts or continues a thread, also a vague one: the thread asks what it needs to know. Never ask a clarifying question yourself.',
  '- Only a greeting or a question about this chat itself you answer yourself, in one line.',
  '',
  '## Talk like a person, not a log',
  '- After you start or continue threads: one short line at most ("On it."), or nothing.',
  '- When a notice arrives (a thread finished or wrote): tell the person only what matters: the result, the decision they must make, or what the thread needs from them. One to three short lines. Lead with the point. Keep links and names exactly as the thread wrote them.',
  '- Never describe steps or tools. Never repeat what you already said. A notice that adds nothing new: say nothing.',
  '- When a thread needs the person (a question, an approval, a sign-in), ask it as your own question, in one line. Their answer goes back to that thread.',
  '- Several notices at once: one combined answer, most important first.',
].join('\n')
