import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"

function makeWorkspace(): string {
  return mkdtempSync(join(tmpdir(), "kortix-trigger-agent-e2e-"))
}

function runPluginScenario(workspaceRoot: string) {
  const script = String.raw`
const workspaceRoot = process.env.KORTIX_WORKSPACE
const pluginMod = await import(new URL("./opencode/plugin/kortix-system/kortix-system.ts?e2e=" + Date.now(), import.meta.url).href)
const promptCalls = []
const plugin = await pluginMod.default({
  client: {
    session: {
      create: async () => ({ data: { id: "ses_test_trigger_tool" } }),
      promptAsync: async (params) => { promptCalls.push(params); return {} },
    },
  },
})
const ctx = {}
const keys = Object.keys(plugin.tool || {})
const create = await plugin.tool.triggers.execute({
  action: "create",
  name: "Random Fun Fact",
  source_type: "cron",
  cron_expr: "0 0 12 * * *",
  timezone: "UTC",
  action_type: "prompt",
  prompt: "Share one surprising fun fact.",
}, ctx)
const list = await plugin.tool.triggers.execute({ action: "list" }, ctx)
const get = await plugin.tool.triggers.execute({ action: "get", trigger_id: "Random Fun Fact" }, ctx)
const triggerId = JSON.parse(get).id
const run = await plugin.tool.triggers.execute({ action: "run", trigger_id: triggerId }, ctx)
const executions = await plugin.tool.triggers.execute({ action: "executions", trigger_id: triggerId }, ctx)
const yamlBeforeDelete = await Bun.file(workspaceRoot + "/.kortix/triggers.yaml").text()
const remove = await plugin.tool.triggers.execute({ action: "delete", trigger_id: triggerId }, ctx)
const finalList = await plugin.tool.triggers.execute({ action: "list" }, ctx)
const yamlAfterDelete = await Bun.file(workspaceRoot + "/.kortix/triggers.yaml").text()
console.log(JSON.stringify({
  hasTriggers: keys.includes("triggers"),
  triggerKeys: keys.filter((k) => k.includes("trigger")),
  create,
  list,
  get,
  triggerId,
  run,
  executions,
  yamlBeforeDelete,
  remove,
  finalList,
  yamlAfterDelete,
  promptCalls,
}, null, 2))
process.exit(0)
`

  const result = spawnSync("bun", ["-e", script], {
    cwd: "/Users/markokraemer/Projects/heyagi/suna/core/kortix-master",
    env: {
      ...process.env,
      KORTIX_WORKSPACE: workspaceRoot,
      KORTIX_TRIGGER_WEBHOOK_PORT: "0",
      KORTIX_DISABLE_CORE_SUPERVISOR: "true",
    },
    encoding: "utf8",
  })

  if (result.status !== 0) {
    throw new Error(`plugin scenario failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
  }

  const lines = result.stdout.trim().split(/\r?\n/)
  const start = lines.findIndex((line) => line.trim().startsWith("{"))
  if (start === -1) throw new Error(`no JSON output found\nstdout:\n${result.stdout}`)
  return JSON.parse(lines.slice(start).join("\n")) as {
    hasTriggers: boolean
    triggerKeys: string[]
    create: string
    list: string
    get: string
    triggerId: string
    run: string
    executions: string
    yamlBeforeDelete: string
    remove: string
    finalList: string
    yamlAfterDelete: string
    promptCalls: Array<any>
  }
}

describe("Kortix trigger tool agent e2e", () => {
  let workspaceRoot = ""

  afterEach(() => {
    if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true })
    workspaceRoot = ""
  })

  test("kortix-system exposes trigger tools and they work through the returned tool registry", () => {
    workspaceRoot = makeWorkspace()
    const result = runPluginScenario(workspaceRoot)

    expect(result.hasTriggers).toBe(true)
    expect(result.triggerKeys).toEqual(expect.arrayContaining([
      "triggers",
      "agent_triggers",
      "sync_agent_triggers",
      "cron_triggers",
      "event_triggers",
    ]))

    expect(result.create).toContain("Trigger created: Random Fun Fact")
    expect(result.list).toContain("Random Fun Fact")
    expect(result.get).toContain('"name": "Random Fun Fact"')
    expect(result.triggerId).toBeTruthy()
    expect(result.run).toContain("Trigger fired manually. Execution:")
    expect(result.executions).toContain('"status": "completed"')
    expect(result.yamlBeforeDelete).toContain("name: Random Fun Fact")
    expect(result.yamlBeforeDelete).toContain("cron_expr: 0 0 12 * * *")
    expect(result.remove).toContain("Trigger deleted.")
    expect(result.finalList).toContain("No triggers configured.")
    expect(result.yamlAfterDelete).not.toContain("name: Random Fun Fact")
    expect(result.promptCalls).toHaveLength(1)
    expect(result.promptCalls[0]?.body?.parts?.[0]?.text || "").toContain("Share one surprising fun fact.")
  })

  test("kortix agent instructions explicitly direct the model to use trigger tools", () => {
    const kortixPrompt = readFileSync(
      "/Users/markokraemer/Projects/heyagi/suna/core/kortix-master/opencode/agents/kortix.md",
      "utf8",
    )

    expect(kortixPrompt).toContain("If a user asks you to create, inspect, pause, resume, run, or sync triggers, start with the `triggers` tool")
    expect(kortixPrompt).toContain("triggers action=create")
    expect(kortixPrompt).toContain("triggers action=list")
    expect(kortixPrompt).toContain("Do **not** invent a `ktriggers` CLI")
  })
})
