import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import type { WebhookTriggerConfig } from "./types.js"

export interface WebhookRoute {
  agentName: string
  trigger: WebhookTriggerConfig
}

type DispatchHandler = (route: WebhookRoute, payload: { body: string; headers: Record<string, string>; method: string; path: string }) => Promise<{ sessionId: string }>

type PipedreamEventHandler = (listenerId: string, payload: { body: string; headers: Record<string, string> }) => Promise<{ sessionId: string } | { error: string; status: number }>

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
    req.on("error", reject)
  })
}

function extractHeaders(req: IncomingMessage): Record<string, string> {
  return Object.fromEntries(
    Object.entries(req.headers).map(([key, value]) => [key, Array.isArray(value) ? value.join(",") : value ?? ""]),
  )
}

/** Match /events/pipedream/<listenerId> */
function matchPipedreamRoute(pathname: string): string | null {
  const match = pathname.match(/^\/events\/pipedream\/([a-zA-Z0-9_-]+)$/)
  return match ? match[1]! : null
}

export class WebhookTriggerServer {
  private server: Server | null = null
  private routes = new Map<string, WebhookRoute>()
  private pipedreamHandler: PipedreamEventHandler | null = null
  private reloadHandler: (() => Promise<void> | void) | null = null
  private runHandler: ((id: string) => Promise<{ executionId: string } | null>) | null = null
  private writeThroughHandler: (() => Promise<void> | void) | null = null

  constructor(
    private readonly host: string,
    private readonly port: number,
    private readonly dispatch: DispatchHandler,
  ) {}

  /** Register a callback for POST /internal/reload. Used by kortix-master's
   *  HTTP triggers route to poke the in-plugin manager after creating a
   *  trigger via direct DB access (since that path bypasses manager.createTrigger). */
  setReloadHandler(handler: () => Promise<void> | void): void {
    this.reloadHandler = handler
  }

  /** Register a callback for POST /internal/run/:id — dispatches a trigger
   *  through the in-memory manager (real fire path: action dispatcher runs).
   *  kortix-master's HTTP /run hits this; without it, /run only logs a
   *  stale execution row and nothing actually fires. */
  setRunHandler(handler: (id: string) => Promise<{ executionId: string } | null>): void {
    this.runHandler = handler
  }

  /** Register a callback for POST /internal/write-through — flushes current
   *  DB trigger state into .kortix/triggers.yaml. kortix-master's seed path
   *  writes triggers directly into the DB for atomicity (same process)
   *  but doesn't touch the YAML. Without this flush, the next YAML
   *  reconcile would see "DB has rows YAML doesn't know about" and delete
   *  them. Seed path calls this right after INSERT to keep YAML in sync. */
  setWriteThroughHandler(handler: () => Promise<void> | void): void {
    this.writeThroughHandler = handler
  }

  private routeKey(method: string, path: string): string {
    return `${method.toUpperCase()} ${path}`
  }

  setRoutes(routes: WebhookRoute[]): void {
    this.routes.clear()
    for (const route of routes) {
      this.routes.set(this.routeKey(route.trigger.source.method ?? "POST", route.trigger.source.path), route)
    }
  }

  /** Register a handler for Pipedream event delivery at POST /events/pipedream/:listenerId */
  setPipedreamHandler(handler: PipedreamEventHandler): void {
    this.pipedreamHandler = handler
  }

  async start(): Promise<void> {
    if (this.server) return
    this.server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      const method = (req.method ?? "GET").toUpperCase()
      const pathname = new URL(req.url ?? "/", `http://${this.host}:${this.port}`).pathname

      // Health endpoint
      if (pathname === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ ok: true, service: "kortix-triggers", routes: this.routes.size }))
        return
      }

      // Internal run — kortix-master's /kortix/triggers/:id/run forwards here
      // so the trigger actually dispatches through the in-memory manager
      // (cron tick path). Direct DB execution inserts without this wouldn't
      // wake the action dispatcher.
      if (method === "POST" && pathname.startsWith("/internal/run/")) {
        const id = pathname.slice("/internal/run/".length)
        if (!id) {
          res.writeHead(400, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ ok: false, error: "missing_trigger_id" }))
          return
        }
        if (!this.runHandler) {
          res.writeHead(503, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ ok: false, error: "run_handler_not_registered" }))
          return
        }
        try {
          const result = await this.runHandler(id)
          if (!result) {
            res.writeHead(404, { "Content-Type": "application/json" })
            res.end(JSON.stringify({ ok: false, error: "trigger_not_found" }))
            return
          }
          res.writeHead(200, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ ok: true, executionId: result.executionId }))
        } catch (err) {
          res.writeHead(500, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }))
        }
        return
      }

      // Internal write-through — flush current DB triggers to
      // .kortix/triggers.yaml. Seed path calls this right after inserting
      // rows directly into the DB, so the YAML reconciler doesn't later
      // wipe them as "DB has rows YAML doesn't know about".
      if (method === "POST" && pathname === "/internal/write-through") {
        if (!this.writeThroughHandler) {
          res.writeHead(503, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ ok: false, error: "write_through_handler_not_registered" }))
          return
        }
        try {
          await this.writeThroughHandler()
          res.writeHead(200, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ ok: true }))
        } catch (err) {
          res.writeHead(500, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }))
        }
        return
      }

      // Internal reload — kortix-master hits this after a /kortix/triggers
      // CRUD call to force the in-plugin manager to re-register cron jobs +
      // webhook routes from the DB.
      if (method === "POST" && pathname === "/internal/reload") {
        if (!this.reloadHandler) {
          res.writeHead(503, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ ok: false, error: "reload_handler_not_registered" }))
          return
        }
        try {
          await this.reloadHandler()
          res.writeHead(200, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ ok: true, routes: this.routes.size }))
        } catch (err) {
          res.writeHead(500, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }))
        }
        return
      }

      // Pipedream event receiver: POST /events/pipedream/:listenerId
      if (method === "POST" && this.pipedreamHandler) {
        const listenerId = matchPipedreamRoute(pathname)
        if (listenerId) {
          try {
            const body = await readBody(req)
            const headers = extractHeaders(req)
            const result = await this.pipedreamHandler(listenerId, { body, headers })
            if ("error" in result) {
              res.writeHead(result.status, { "Content-Type": "application/json" })
              res.end(JSON.stringify({ ok: false, error: result.error }))
            } else {
              res.writeHead(202, { "Content-Type": "application/json" })
              res.end(JSON.stringify({ ok: true, sessionId: result.sessionId }))
            }
          } catch (err) {
            res.writeHead(500, { "Content-Type": "application/json" })
            res.end(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }))
          }
          return
        }
      }

      // Standard webhook routes
      const route = this.routes.get(this.routeKey(method, pathname))
      if (!route) {
        res.writeHead(404, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ ok: false, error: "not_found" }))
        return
      }

      const body = await readBody(req)
      const headers = extractHeaders(req)

      if (route.trigger.source.secret) {
        const supplied = headers["x-kortix-opencode-trigger-secret"] ?? headers["x-kortix-trigger-secret"] ?? ""
        if (supplied !== route.trigger.source.secret) {
          res.writeHead(401, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ ok: false, error: "invalid_secret" }))
          return
        }
      }

      const result = await this.dispatch(route, { body, headers, method, path: pathname })
      res.writeHead(202, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ ok: true, sessionId: result.sessionId }))
    })

    await new Promise<void>((resolve, reject) => {
      this.server?.once("error", reject)
      this.server?.listen(this.port, this.host, () => resolve())
    })
  }

  async stop(): Promise<void> {
    if (!this.server) return
    const current = this.server
    this.server = null
    await new Promise<void>((resolve, reject) => current.close((error) => (error ? reject(error) : resolve())))
  }
}
