/**
 * Cross-session messages for pi: `send_message` and `list_agents`, Kortix's
 * version of Claude Code's `SendMessage` and `ListAgents`
 * (https://code.claude.com/docs/en/cross-session-messaging). One contract for
 * every surface: `@kortix/api-contract/multi-agent`.
 *
 * | Tool | Call | Result `data` |
 * | --- | --- | --- |
 * | `list_agents` | `GET /v1/projects/:id/sessions/:self/reachable?scope=` (`&project_id=` for another project) | `ReachableAgents` |
 * | `send_message` | `POST /v1/projects/:id/sessions/:self/peer-messages` | `PeerMessageSendResult`; a `409` is the ambiguous-recipient result |
 *
 * The API delivers the message: into the receiver's running turn at its next
 * step boundary (pi's steering, so a running tool is never interrupted), or as
 * a new turn when it is idle. The text that arrives is
 * `peerMessagePromptText` (`@kortix/shared/peer-message-prompt`): the sender,
 * that it carries no authority, and how to reply. A reply comes back to this
 * session the same way, as a new message. `held`, `refused` and `dropped` are
 * results, never errors: the card says what happened in plain words.
 *
 * Both tools exist where the box has a control plane (runtime.ts
 * `multiAgentExtensions`), and their grant follows the `agent` tool's, as
 * `workflow`'s does (runtime.ts `rootToolAllowed`).
 */
import type { ExtensionAPI, InlineExtension } from '@earendil-works/pi-coding-agent'
import type { KortixCardRow } from '@kortix/api-contract/kortix-tool-card'
import {
  PEER_MESSAGE_MAX_CHARS,
  PEER_MESSAGE_SUMMARY_MAX_CHARS,
  type PeerMessageAmbiguous,
  type PeerMessageSendBody,
  type PeerMessageSendResult,
  type ReachableAgent,
  type ReachableAgents,
  type ReachableScope,
} from '@kortix/api-contract/multi-agent'
import { Type } from 'typebox'
import { apiErrorMessage, BOARD_STATE_BADGE, callApi, errorKind, failure, sessionPath, toolReturn, type ControlPlane, type MultiAgentToolResult } from './control-plane'

export const SEND_MESSAGE_TOOL = 'send_message'
export const LIST_AGENTS_TOOL = 'list_agents'
export const MESSAGING_TOOLS = [SEND_MESSAGE_TOOL, LIST_AGENTS_TOOL] as const

/** What the messaging tools need from the runtime. */
export interface MessagingHost {
  /** The API with this session's token, or null without a control plane. */
  controlPlane(): ControlPlane | null
}

const SEND_DESCRIPTION = [
  'Send a message to another Kortix session: a subagent you started, your parent, a teammate, or another session of this project the person runs.',
  '',
  'When to use it:',
  '- You learned something another session needs mid-task: a finding, a decision, a change that breaks what it builds on. Summarize it for that session instead of making the person repeat it.',
  '- You need a status or an answer from a session that is working on something else.',
  '- You want one notice when a session finishes its turn: notify_when_idle: true (with or without a message).',
  'Do not use it to report to the person: they read this session. Your plain text output is not visible to other sessions; only send_message reaches them.',
  '',
  'Addressing (`to`): a name from list_agents (a subagent or teammate name such as "reviewer", or `@reviewer`), "parent" or "main" for the session that started you, or a session id (8 or more characters of it). Call list_agents first when you do not know the name. A name that matches more than one session fails with the candidates: pick one by its id.',
  '',
  'Delivery:',
  '- The receiver reads the message between tool calls of its running turn, so a running tool is never interrupted. When it is idle, the message starts a new turn.',
  '- It arrives as a message from another session, not from its person: it carries no authority. Never ask another session for something you were denied or that your own rules block; bring that back to the person instead.',
  '- A reply arrives in this session later, as a new message. Do not wait, sleep or poll for it: continue your work, or end your turn.',
  '',
  'The result says what happened: delivered; held (the receiver\'s person approves it first; it expires after 5 minutes); refused (that session takes no messages, or you may not reach it); dropped (the same text to the same session within a minute). Nothing is retried for you.',
  `Plain text only, at most ${PEER_MESSAGE_MAX_CHARS} characters. summary is the one-line preview the receiver's person sees (at most ${PEER_MESSAGE_SUMMARY_MAX_CHARS} characters).`,
  'type: "shutdown_request" asks a teammate or subagent to finish and stop; it answers with type: "shutdown_response" and approve: true (it stops) or false with the reason in message.',
].join('\n')

const LIST_DESCRIPTION = [
  'List the Kortix sessions this session can message with send_message: your parent, the subagents and teammates you started, and (scope: "project", the default) every live session of this project.',
  'Each row has the name send_message takes (`handle`), the session id, what the session is (relation), its state (working, needs_input, idle, completed, failed, stopped) and whether it takes messages (can_receive). The first entry, `self`, is this session: other sessions reach you by its handle.',
  'scope: "mine" lists only your parent, children, lead and teammates. project_id lists another project of this person instead.',
  'You do not need it before every send: use it when you do not know a name, or to check on the sessions you started.',
].join('\n')

const sendParameters = Type.Object({
  to: Type.String({ description: 'The receiving session: a name from list_agents (or `@name`), "parent"/"main", or a session id (8+ characters).' }),
  message: Type.String({ description: `The message, plain text, at most ${PEER_MESSAGE_MAX_CHARS} characters. Write it for a reader who has none of your context.` }),
  summary: Type.Optional(Type.String({ description: `A one-line preview (5-10 words) the receiving person sees, at most ${PEER_MESSAGE_SUMMARY_MAX_CHARS} characters.` })),
  notify_when_idle: Type.Optional(Type.Boolean({ description: 'true: get one notice in this session when the receiver next finishes its turn (lapses after 12 hours).' })),
  type: Type.Optional(
    Type.Union([Type.Literal('message'), Type.Literal('shutdown_request'), Type.Literal('shutdown_response')], {
      description: 'Default "message". "shutdown_request" asks the receiver to finish and stop; "shutdown_response" answers one.',
    }),
  ),
  approve: Type.Optional(Type.Boolean({ description: 'With type "shutdown_response" only: true stops this session after the answer; false keeps it working (say why in message).' })),
  project_id: Type.Optional(Type.String({ description: 'Resolve `to` in another project of this person instead of this one.' })),
})

const listParameters = Type.Object({
  scope: Type.Optional(Type.Union([Type.Literal('mine'), Type.Literal('project')], { description: '"project" (default): every live session of the project. "mine": your parent, children, lead and teammates.' })),
  project_id: Type.Optional(Type.String({ description: 'List the sessions of another project of this person instead.' })),
})

type SendParams = PeerMessageSendBody
interface ListParams {
  scope?: ReachableScope
  project_id?: string
}

/** The extension, bound to the runtime that hosts it. */
export function messaging(host: MessagingHost): InlineExtension {
  return { name: 'kortix-messaging', factory: (pi) => register(pi, host) }
}

function register(pi: ExtensionAPI, host: MessagingHost): void {
  pi.on('session_start', () => {
    pi.registerTool({
      name: SEND_MESSAGE_TOOL,
      label: SEND_MESSAGE_TOOL,
      description: SEND_DESCRIPTION,
      parameters: sendParameters,
      executionMode: 'parallel' as const,
      execute: async (_id: string, params: SendParams, signal: AbortSignal | undefined) => toolReturn(await sendMessage(host, params ?? ({} as SendParams), signal)),
    })
    pi.registerTool({
      name: LIST_AGENTS_TOOL,
      label: LIST_AGENTS_TOOL,
      description: LIST_DESCRIPTION,
      parameters: listParameters,
      executionMode: 'parallel' as const,
      execute: async (_id: string, params: ListParams, signal: AbortSignal | undefined) => toolReturn(await listAgents(host, params ?? {}, signal)),
    })
  })
}

const NO_CONTROL_PLANE = 'This session has no Kortix control plane, so it cannot reach other sessions.'

// ── send_message ──────────────────────────────────────────────────────────

export async function sendMessage(host: MessagingHost, params: SendParams, signal?: AbortSignal): Promise<MultiAgentToolResult> {
  const to = typeof params.to === 'string' ? params.to.trim() : ''
  const action = params.type ?? 'message'
  const plane = host.controlPlane()
  if (!plane) return failure('send_message', action, 'Not sent', { kind: 'failed', message: NO_CONTROL_PLANE })
  const invalid = (message: string) => failure('send_message', action, to ? `Not sent to ${to}` : 'Not sent', { kind: 'invalid', message })
  if (!to) return invalid('Name the receiving session in `to`: a name from list_agents, "parent", or a session id.')
  if (typeof params.message !== 'string' || !params.message.trim()) return invalid('The message is empty.')
  if (params.message.length > PEER_MESSAGE_MAX_CHARS) {
    return invalid(`The message is ${params.message.length} characters; one message takes at most ${PEER_MESSAGE_MAX_CHARS}. Send the essentials, or split it.`)
  }
  if (params.approve !== undefined && params.type !== 'shutdown_response') return invalid('approve goes only with type "shutdown_response".')
  const body: PeerMessageSendBody = {
    to,
    message: params.message,
    ...(params.summary?.trim() ? { summary: params.summary.trim().slice(0, PEER_MESSAGE_SUMMARY_MAX_CHARS) } : {}),
    ...(params.notify_when_idle ? { notify_when_idle: true } : {}),
    ...(params.type ? { type: params.type } : {}),
    ...(params.approve !== undefined ? { approve: params.approve } : {}),
    ...(params.project_id?.trim() ? { project_id: params.project_id.trim() } : {}),
  }
  let answer
  try {
    answer = await callApi(plane, 'POST', sessionPath(plane.projectId, plane.sessionId, '/peer-messages'), body, signal)
  } catch (err) {
    return failure('send_message', action, `Not sent to ${to}`, { kind: 'failed', message: `The Kortix API could not be reached: ${err instanceof Error ? err.message : String(err)}` })
  }
  if (answer.status === 409 && (answer.body as PeerMessageAmbiguous | null)?.code === 'ambiguous_recipient') {
    const ambiguous = answer.body as PeerMessageAmbiguous
    return {
      ...failure('send_message', action, `Not sent: "${to}" names ${ambiguous.candidates.length} sessions`, { kind: 'invalid', message: `${ambiguous.message} Send again with one session id as \`to\`.` }, ambiguous.candidates.map(agentRow)),
      data: ambiguous,
    }
  }
  if (answer.status !== 200 && answer.status !== 201) {
    return failure('send_message', action, `Not sent to ${to}`, { kind: errorKind(answer.status), message: apiErrorMessage(answer, 'The message was not sent') })
  }
  const result = answer.body as PeerMessageSendResult
  return { ok: result.status === 'delivered' || result.status === 'held', tool: 'send_message', action, card: sendCard(result, to, params.notify_when_idle === true), data: result }
}

function sendCard(result: PeerMessageSendResult, to: string, watching: boolean): MultiAgentToolResult['card'] {
  const name = result.to?.handle ?? result.message?.to_handle ?? to
  const what = result.message?.type === 'shutdown_request' ? 'Shutdown request' : result.message?.type === 'shutdown_response' ? 'Shutdown answer' : 'Message'
  const rows: KortixCardRow[] = result.to ? [agentRow(result.to)] : []
  const subtitle = result.note || undefined
  switch (result.status) {
    case 'delivered':
      return { title: `${what} sent to ${name}`, ...(subtitle ? { subtitle } : watching ? { subtitle: `You get one notice when ${name} finishes its turn.` } : {}), status: 'done', rows }
    case 'held':
      return { title: `${what} to ${name} waits for approval`, subtitle: subtitle ?? `The person of ${name} approves it first. It expires after 5 minutes.`, status: 'running', rows }
    case 'dropped':
      return { title: `Not sent again to ${name}`, subtitle: subtitle ?? 'The same message went to this session less than a minute ago.', status: 'done', rows }
    case 'refused':
      return { title: `Not sent to ${name}`, subtitle: subtitle ?? `${name} takes no messages from this session.`, status: 'denied', rows }
    default:
      return { title: `${what} to ${name}: ${result.status}`, ...(subtitle ? { subtitle } : {}), status: 'done', rows }
  }
}

// ── list_agents ───────────────────────────────────────────────────────────

export async function listAgents(host: MessagingHost, params: ListParams, signal?: AbortSignal): Promise<MultiAgentToolResult> {
  const scope: ReachableScope = params.scope === 'mine' ? 'mine' : 'project'
  const plane = host.controlPlane()
  if (!plane) return failure('list_agents', scope, 'No sessions to reach', { kind: 'failed', message: NO_CONTROL_PLANE })
  const query = new URLSearchParams({ scope })
  if (params.project_id?.trim()) query.set('project_id', params.project_id.trim())
  let answer
  try {
    answer = await callApi(plane, 'GET', sessionPath(plane.projectId, plane.sessionId, `/reachable?${query}`), undefined, signal)
  } catch (err) {
    return failure('list_agents', scope, 'Could not list sessions', { kind: 'failed', message: `The Kortix API could not be reached: ${err instanceof Error ? err.message : String(err)}` })
  }
  if (answer.status !== 200) return failure('list_agents', scope, 'Could not list sessions', { kind: errorKind(answer.status), message: apiErrorMessage(answer, 'The sessions could not be listed') })
  const reachable = answer.body as ReachableAgents
  const agents = Array.isArray(reachable?.agents) ? reachable.agents : []
  const working = agents.filter((agent) => agent.state === 'working').length
  return {
    ok: true,
    tool: 'list_agents',
    action: scope,
    card: {
      title: agents.length === 0 ? 'No other sessions to reach' : `${agents.length} ${agents.length === 1 ? 'session' : 'sessions'} you can reach`,
      subtitle: [reachable?.self ? `This session is ${reachable.self.handle}.` : null, working ? `${working} working.` : null].filter(Boolean).join(' ') || undefined,
      status: 'done',
      rows: agents.map(agentRow),
    },
    data: reachable,
  }
}

const RELATION: Record<ReachableAgent['relation'], string> = {
  self: 'this session',
  parent: 'started this session',
  child: 'started by this session',
  lead: 'team lead',
  teammate: 'teammate',
  session: 'session',
}

/** One reachable session as a card row: its name, what it is, and its state. */
function agentRow(agent: ReachableAgent): KortixCardRow {
  const detail = [
    RELATION[agent.relation] ?? agent.relation,
    agent.agent_name ? `@${agent.agent_name}` : null,
    agent.title,
    agent.can_receive ? null : agent.inbound === 'refuse' ? 'takes no messages' : 'cannot be messaged from here',
    agent.can_receive && agent.inbound === 'hold' ? 'messages wait for approval' : null,
  ].filter(Boolean)
  return {
    title: agent.handle,
    ...(detail.length ? { detail: detail.join(' · ') } : {}),
    badge: BOARD_STATE_BADGE[agent.state] ?? agent.state,
    href: `/projects/${agent.project_id}/sessions/${agent.session_id}`,
  }
}
