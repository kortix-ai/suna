/**
 * emit_file_artifact — emit a file_artifact CanvasMessage after the agent
 * has written a file to the sandbox filesystem.
 *
 * Stats the file at `path`, validates the MIME type, then POSTs a canvas
 * event to the Kortix backend canvas store so the frontend can render the
 * download card.
 *
 * The file stays in the sandbox — no upload to external storage.
 * Frontend downloads via the existing sandbox file proxy.
 */

import { tool } from "@opencode-ai/plugin"
import { getEnv } from "./lib/get-env"
import { existsSync, statSync } from "node:fs"
import { basename } from "node:path"
import { randomUUID } from "node:crypto"

const ALLOWED_MIMES = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "text/csv",
  "image/png",
  "image/jpeg",
])

const MIME_LABELS: Record<string, string> = {
  "application/pdf": "PDF",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "Excel",
  "text/csv": "CSV",
  "image/png": "PNG",
  "image/jpeg": "JPEG",
}

export default tool({
  description:
    "Emit a file artifact canvas card so the user can download a file the agent has generated in the sandbox. " +
    "The file must already exist on the sandbox filesystem. " +
    "Supported mime types: application/pdf, application/vnd.openxmlformats-officedocument.spreadsheetml.sheet, text/csv, image/png, image/jpeg.",
  args: {
    path: tool.schema
      .string()
      .describe("Absolute path to the file in the sandbox, e.g. /workspace/report.pdf"),
    mime_type: tool.schema
      .string()
      .describe(
        "MIME type of the file. Must be one of: application/pdf, " +
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet, " +
        "text/csv, image/png, image/jpeg",
      ),
    description: tool.schema
      .string()
      .optional()
      .describe("Optional human-readable description shown on the download card"),
  },
  async execute(
    args: { path: string; mime_type: string; description?: string },
    ctx: import("@opencode-ai/plugin").ToolContext,
  ): Promise<string> {
    const { path, mime_type, description } = args

    // Validate MIME type
    if (!ALLOWED_MIMES.has(mime_type)) {
      return JSON.stringify({
        success: false,
        error: `Unsupported mime_type "${mime_type}". Allowed types: ${[...ALLOWED_MIMES].join(", ")}`,
      })
    }

    // Stat the file
    if (!existsSync(path)) {
      return JSON.stringify({ success: false, error: `file not found: ${path}` })
    }

    let size_bytes: number
    try {
      const stat = statSync(path)
      if (!stat.isFile()) {
        return JSON.stringify({ success: false, error: `path is not a regular file: ${path}` })
      }
      size_bytes = stat.size
    } catch (err) {
      return JSON.stringify({
        success: false,
        error: `Failed to stat file: ${err instanceof Error ? err.message : String(err)}`,
      })
    }

    const filename = basename(path)
    const sandboxId = getEnv("SANDBOX_ID") ?? getEnv("KORTIX_SANDBOX_ID") ?? "sandbox"
    const sessionId = ctx.sessionID
    const canvasEventId = randomUUID()

    const canvasEvent = {
      type: "canvas",
      kind: "file_artifact",
      id: canvasEventId,
      data: {
        filename,
        sandbox_path: path,
        sandbox_id: sandboxId,
        mime_type,
        size_bytes,
        ...(description ? { description } : {}),
      },
    }

    // POST canvas event to Kortix API for storage + SSE fan-out
    const apiUrl = (getEnv("KORTIX_API_URL") ?? getEnv("KORTIX_URL") ?? "")
      .replace(/\/v1\/router\/?$/, "")
      .replace(/\/+$/, "")
    const token = getEnv("KORTIX_TOKEN")

    if (apiUrl && token) {
      try {
        await fetch(`${apiUrl}/v1/canvas/${encodeURIComponent(sessionId)}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify(canvasEvent),
          signal: AbortSignal.timeout(5_000),
        })
      } catch {
        // Non-fatal — canvas emit is best-effort; still return success so the
        // agent doesn't retry and the user can manually find the file.
      }
    }

    return JSON.stringify({
      success: true,
      canvas_event_id: canvasEventId,
      filename,
      size_bytes,
      mime_label: MIME_LABELS[mime_type] ?? mime_type,
    })
  },
})
