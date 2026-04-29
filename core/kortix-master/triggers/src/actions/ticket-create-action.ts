/**
 * Ticket-create action — turns a trigger fire into a new ticket in the
 * trigger's bound project. The trigger itself is agnostic to source: a
 * cron tick, a webhook POST, or a manual run all land here.
 *
 * Title / body / custom_fields support `{{ var }}` templating against the
 * event payload (same renderer as prompt-action). Team routing happens via
 * `assignee_slugs` on the action config, resolved to agent IDs at dispatch
 * time — or omitted entirely to let the column's default_assignee rule fire.
 *
 * Engine stays unaware of this DB shape — we open our own sqlite handle at
 * the workspace path to call `createTicket` directly.
 */
import type { TriggerRecord, TicketCreateActionConfig, MinimalOpenCodeClient } from "../types.js"
import { Database } from "bun:sqlite"
import { join } from "path"
import { createTicket, getAgentBySlug, getAgentById, listColumns } from "../../../src/services/ticket-service"
import { fireAgentTrigger } from "../../../src/services/ticket-triggers"

export interface TicketCreateActionResult {
  ticketId: string
  ticketNumber: number
}

function getWorkspaceDbPath(): string {
  const root = process.env.WORKSPACE_DIR || process.env.KORTIX_WORKSPACE || "/workspace"
  return join(root, ".kortix", "kortix.db")
}

function getPathValue(input: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((current, part) => {
    if (current === null || current === undefined || typeof current !== "object") return undefined
    return (current as Record<string, unknown>)[part]
  }, input)
}

function render(template: string, values: Record<string, unknown>): string {
  return template.replace(/{{\s*([a-zA-Z0-9_.]+)\s*}}/g, (_, key: string) => {
    const v = getPathValue(values, key) ?? values[key]
    if (v === null || v === undefined) return ""
    return typeof v === "string" ? v : JSON.stringify(v)
  })
}

export async function executeTicketCreateAction(
  client: MinimalOpenCodeClient,
  trigger: TriggerRecord,
  event: { type: string; data?: unknown; manual?: boolean; timestamp: string },
): Promise<TicketCreateActionResult> {
  const cfg = JSON.parse(trigger.action_config) as TicketCreateActionConfig
  if (!cfg.title || !cfg.title.trim()) {
    throw new Error("ticket_create: title is required")
  }

  // The trigger must be scoped to a project — we refuse to create tickets
  // at workspace level since it has no tickets table semantics.
  const projectId = trigger.project_id
  if (!projectId) {
    throw new Error("ticket_create: trigger must be bound to a project (project_id unset)")
  }
  // Fire-time validation: verify the stored project_id still exists in the
  // DB. PM-authored triggers have hallucinated IDs in the past (`proj-<random>`
  // that never mapped to a real project) — at creation they stamp whatever
  // PM typed, and every fire then fails with a useless "column not found"
  // error because listColumns returns []. Fail FAST with a clear message
  // that names the bad ID, so operators can patch or recreate the trigger.
  {
    const probeDb = new Database(getWorkspaceDbPath())
    probeDb.exec("PRAGMA busy_timeout=5000")
    try {
      const exists = probeDb.prepare("SELECT 1 FROM projects WHERE id=$id").get({ $id: projectId })
      if (!exists) {
        throw new Error(
          `ticket_create: trigger is stamped with project_id="${projectId}" but that project does not exist. ` +
          `The trigger was likely created with a hallucinated id. ` +
          `Fix via PATCH /kortix/triggers/<id> or recreate with the correct project_id.`,
        )
      }
    } finally { probeDb.close() }
  }

  // Build a template context. Webhook payloads come nested under
  // `event.data.body` (the parsed JSON body), while cron fires have
  // `event.data = { timestamp, manual }`. Expose both top-level for
  // convenience — `{{ summary }}` resolves to `event.data.body.summary`
  // first (webhook case), then `event.data.summary` (cron/direct).
  const flat: Record<string, unknown> = {}
  if (event.data && typeof event.data === "object" && !Array.isArray(event.data)) {
    const d = event.data as Record<string, unknown>
    // Spread `data.body` FIRST so webhook body keys live at the top level.
    if (d.body && typeof d.body === "object" && !Array.isArray(d.body)) {
      for (const [k, v] of Object.entries(d.body as Record<string, unknown>)) flat[k] = v
    }
    // Then spread `data` itself — overrides won't clobber webhook keys since
    // we already took them from `data.body`, but cron events land here.
    for (const [k, v] of Object.entries(d)) {
      if (!(k in flat)) flat[k] = v
    }
  }
  // Also expose the event envelope itself so templates can read event.timestamp etc.
  flat.event = {
    type: event.type,
    timestamp: event.timestamp,
    manual: event.manual ?? false,
    trigger: trigger.name,
  }

  const title = render(cfg.title, flat).trim()
  const body = cfg.body_md ? render(cfg.body_md, flat) : ""

  const db = new Database(getWorkspaceDbPath())
  db.exec("PRAGMA busy_timeout=5000")
  try {
    // Resolve optional column — if unset, createTicket picks the first one.
    const cols = listColumns(db, projectId)
    let status: string | undefined
    if (cfg.column) {
      const match = cols.find((c) => c.key === cfg.column)
      if (!match) throw new Error(`ticket_create: column "${cfg.column}" not found in project`)
      status = match.key
    }

    // Resolve assignee slugs → agent IDs. Silently skip unknown slugs — the
    // alternative (hard fail) is worse UX when an agent was renamed/deleted
    // after the trigger was authored.
    const assign_to: Array<{ type: "agent"; id: string }> = []
    for (const slug of cfg.assignee_slugs ?? []) {
      const ag = getAgentBySlug(db, projectId, slug)
      if (ag) assign_to.push({ type: "agent", id: ag.id })
    }

    const result = createTicket(db, {
      project_id: projectId,
      title,
      body_md: body,
      template_id: cfg.template_id ?? null,
      status,
      assign_to: assign_to.length ? assign_to : undefined,
      created_by_type: "agent",
      created_by_id: null, // trigger-owned; no single agent created it
    })

    // Wake the freshly-assigned agents. Without this the ticket lands on the
    // board but the engineer/qa never notice — they stay asleep until someone
    // manually @-mentions them. Mirrors what ticket_tools.ts ticket_create
    // tool does after its own createTicket call.
    for (const t of result.triggered) {
      const agent = getAgentById(db, t.agent_id)
      if (!agent) continue
      try {
        await fireAgentTrigger({
          db,
          client,
          projectId,
          ticketId: result.ticket.id,
          agent,
          reason: `Ticket created by trigger "${trigger.name}" (action_type=ticket_create). You were routed on create — read the ticket and start work.`,
        })
      } catch (err) {
        console.warn(`[ticket_create] fireAgentTrigger failed for @${agent.slug}:`, err instanceof Error ? err.message : err)
      }
    }

    return { ticketId: result.ticket.id, ticketNumber: result.ticket.number }
  } finally {
    db.close()
  }
}
