/**
 * ActionDispatch — Routes a fired trigger to the appropriate action handler.
 */
import type { MinimalOpenCodeClient, TriggerRecord, ActionType } from "./types.js"
import { TriggerStore } from "./trigger-store.js"
import { executePromptAction } from "./actions/prompt-action.js"
import { executeCommandAction } from "./actions/command-action.js"
import { executeHttpAction } from "./actions/http-action.js"
import { executeTicketCreateAction } from "./actions/ticket-create-action.js"

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
        const result = await executePromptAction(this.client, trigger, event, {
          directory: this.directory,
          reusedSessions: this.reusedSessions,
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
