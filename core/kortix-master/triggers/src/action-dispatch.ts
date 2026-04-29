/**
 * ActionDispatch — Routes a fired trigger to the appropriate action handler.
 */
import type { MinimalOpenCodeClient, TriggerRecord, ActionType } from "./types.js"
import { TriggerStore } from "./trigger-store.js"
import { executePromptAction } from "./actions/prompt-action.js"
import { executeCommandAction } from "./actions/command-action.js"
import { executeHttpAction } from "./actions/http-action.js"
import { executeTicketCreateAction } from "./actions/ticket-create-action.js"

// ─── Background result capture ───────────────────────────────────────────────

/** Poll the session until idle (max 30 min), then capture the last assistant message. */
async function captureResultText(
  client: MinimalOpenCodeClient,
  sessionId: string,
  executionId: string,
  store: TriggerStore,
): Promise<void> {
  const sdk = client as unknown as {
    session: {
      status?: () => Promise<{ data?: Record<string, { type: string }> }>
      messages?: (args: { path: { id: string } }) => Promise<{ data?: Array<{ info: { role: string }; parts: Array<{ type: string; text?: string }> }> }>
    }
  }

  const MAX_WAIT_MS = 30 * 60 * 1000 // 30 min
  const POLL_INTERVAL_MS = 5_000
  const started = Date.now()

  // Poll until session is idle or timeout
  while (Date.now() - started < MAX_WAIT_MS) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
    try {
      const statusRes = await sdk.session.status?.()
      const statuses = statusRes?.data as Record<string, { type: string }> | undefined
      const sessionStatus = statuses?.[sessionId]?.type
      if (!sessionStatus || sessionStatus === "idle") break
    } catch {
      break // If status check fails, try to fetch messages anyway
    }
  }

  // Fetch messages and capture last assistant message
  try {
    const msgsRes = await sdk.session.messages?.({ path: { id: sessionId } })
    const messages = msgsRes?.data ?? []
    // Last message with role: 'assistant'
    const lastAssistant = [...messages].reverse().find(
      (m) => m.info?.role === "assistant",
    )
    if (lastAssistant) {
      const text = lastAssistant.parts
        .filter((p) => p.type === "text")
        .map((p) => p.text ?? "")
        .join("\n")
        .trim()
      if (text) {
        store.updateExecution(executionId, {
          result_text: text.slice(0, 10_000),
        })
      }
    }
  } catch {
    // Non-fatal — result_text stays null
  }
}

export interface DispatchEvent {
  type: string       // "cron.tick" | "webhook.request" | "manual"
  manual?: boolean
  timestamp: string
  data?: unknown      // webhook body, etc.
}

export interface DispatchResult {
  executionId: string
  sessionId?: string
  exitCode?: number
  httpStatus?: number
}

export class ActionDispatcher {
  private readonly running = new Set<string>()
  private readonly reusedSessions = new Map<string, string>()

  constructor(
    private readonly store: TriggerStore,
    private readonly client: MinimalOpenCodeClient,
    private readonly directory?: string,
    private readonly logger?: (level: "info" | "warn" | "error", message: string) => void,
  ) {}

  async dispatch(triggerId: string, event: DispatchEvent): Promise<DispatchResult> {
    const trigger = this.store.get(triggerId)
    if (!trigger) throw new Error(`Trigger not found: ${triggerId}`)

    // Skip if already running (prevent overlap)
    if (this.running.has(triggerId)) {
      const skipped = this.store.createExecution(triggerId, {
        status: "skipped",
        metadata: { reason: "already_running", manual: event.manual ?? false },
      })
      this.store.updateExecution(skipped.id, {
        completed_at: new Date().toISOString(),
        duration_ms: 0,
      })
      return { executionId: skipped.id }
    }

    this.running.add(triggerId)
    const execution = this.store.createExecution(triggerId, {
      status: "running",
      metadata: { manual: event.manual ?? false },
    })
    const started = Date.now()

    try {
      const result = await this.executeAction(trigger, event)

      this.store.markRun(triggerId, result.sessionId ?? null)
      this.store.updateExecution(execution.id, {
        status: "completed",
        session_id: result.sessionId ?? null,
        stdout: result.stdout ?? null,
        stderr: result.stderr ?? null,
        exit_code: result.exitCode ?? null,
        http_status: result.httpStatus ?? null,
        http_body: result.httpBody ?? null,
        completed_at: new Date().toISOString(),
        duration_ms: Date.now() - started,
      })

      // Fire-and-forget: capture the agent's final message as result_text
      // once the session goes idle. Non-blocking — dispatch returns immediately.
      if (trigger.action_type === "prompt" && result.sessionId) {
        captureResultText(this.client, result.sessionId, execution.id, this.store)
          .catch(() => { /* non-fatal */ })
      }

      this.logger?.("info", `[triggers] Dispatched ${trigger.name} (${trigger.action_type}): completed in ${Date.now() - started}ms`)

      return {
        executionId: execution.id,
        sessionId: result.sessionId,
        exitCode: result.exitCode,
        httpStatus: result.httpStatus,
      }
    } catch (error) {
      this.store.updateExecution(execution.id, {
        status: "failed",
        completed_at: new Date().toISOString(),
        duration_ms: Date.now() - started,
        error_message: error instanceof Error ? error.message : String(error),
      })
      this.logger?.("error", `[triggers] Dispatch failed for ${trigger.name}: ${error instanceof Error ? error.message : String(error)}`)
      return { executionId: execution.id }
    } finally {
      this.running.delete(triggerId)
    }
  }

  private async executeAction(trigger: TriggerRecord, event: DispatchEvent): Promise<{
    sessionId?: string
    stdout?: string
    stderr?: string
    exitCode?: number
    httpStatus?: number
    httpBody?: string
  }> {
    const actionType = trigger.action_type as ActionType

    switch (actionType) {
      case "prompt": {
        // Carry state: if carry_state is set, fetch the last completed execution's result_text
        let previousResultText: string | null = null
        if (trigger.carry_state) {
          const lastExec = this.store.listExecutions({ triggerId: trigger.id, limit: 1, offset: 0 })
          const last = lastExec.data.find((e) => e.status === "completed" && e.result_text)
          previousResultText = last?.result_text ?? null
        }

        const result = await executePromptAction(this.client, trigger, event, {
          directory: this.directory,
          reusedSessions: this.reusedSessions,
          previousResultText,
        })
        return { sessionId: result.sessionId }
      }

      case "command": {
        const result = await executeCommandAction(trigger, event)
        return {
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
        }
      }

      case "http": {
        const result = await executeHttpAction(trigger, event)
        return {
          httpStatus: result.httpStatus,
          httpBody: result.httpBody,
        }
      }

      case "ticket_create": {
        const result = await executeTicketCreateAction(this.client, trigger, event)
        // Surface the created ticket in stdout so the execution row is
        // searchable by ticket id — no schema change needed.
        return { stdout: `created ticket #${result.ticketNumber} (${result.ticketId})` }
      }

      default:
        throw new Error(`Unknown action type: ${actionType}`)
    }
  }
}
