import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { CompiledAgentSet } from '@kortix/api-contract/runtime-relay'
import { logger } from '@/lib/log/logger'
import { loadTools, toolBridgeKey } from '@/services/tools/host'
import { toolNamesInDir } from './config-directory-inventory'

/**
 * The platform plugin that gives an OpenCode session the hosted tools
 * (services/tools: the Kortix tools and the project's kortix.yaml `tools`).
 *
 * OpenCode runs in its own process, so the plugin holds no tool code: each
 * tool is a stub that posts its arguments to the daemon (`POST
 * /kortix/tools/:name`), which runs the same module pi runs in process. The
 * tool list (names, descriptions, JSON Schemas), the daemon URL and the key
 * are written to a JSON file beside the plugin each time the config is
 * composed. The plugin reads that file when OpenCode initializes it (every
 * instance, after every dispose), because the process imports the plugin
 * module once and keeps it.
 *
 * OpenCode 1.18.23 sends a plugin tool's non-Zod `args` to the model as JSON
 * Schema properties, every one of them required (tool/registry.ts
 * `legacyJsonSchema`); the `tool.definition` hook puts back the tool's own
 * schema, so optional arguments stay optional.
 *
 * A tool the served config dir defines itself (`tools/<name>.ts`, the copies
 * the project template wrote before the tools were hosted) keeps the
 * project's file: two tools of one name would break every model request.
 */
export function toolBridgeSource(listPath: string): string {
  return `// Written by kortixd (harness/open-code/tool-bridge.ts). Do not edit.
import { readFileSync } from 'node:fs'

const LIST = ${JSON.stringify(listPath)}

export const KortixTools = async () => {
  const { url, key, tools } = JSON.parse(readFileSync(LIST, 'utf8'))
  const schemas = new Map(tools.map((tool) => [tool.name, tool.parameters]))
  const run = (name) => async (args, context) => {
    const response = await fetch(url + name, {
      method: 'POST',
      headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' },
      body: JSON.stringify({ args, agent: context.agent, directory: context.directory }),
      signal: context.abort,
    })
    const body = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(body.error ?? 'kortixd answered ' + response.status)
    return body.output
  }
  return {
    tool: Object.fromEntries(
      tools.map((tool) => [tool.name, { description: tool.description, args: tool.parameters.properties ?? {}, execute: run(tool.name) }]),
    ),
    'tool.definition': async (input, output) => {
      const schema = schemas.get(input.toolID)
      if (schema) output.jsonSchema = schema
    },
  }
}
`
}

/**
 * Load the hosted tools, write the bridge plugin to `path` and its tool list
 * beside it, and return the plugin's `file://` spec. `projectRoot` is the
 * checkout OpenCode serves its config from (the working tree or a release);
 * null loads only the Kortix tools. The list holds only the loaded tools: a
 * Kortix tool the project does not list is not in it.
 */
export async function writeToolBridge(
  path: string,
  input: { env: NodeJS.ProcessEnv; daemonPort: number; projectRoot: string | null; configDir: string | null },
): Promise<string> {
  const { tools } = await loadTools(input.projectRoot, compiledTools(input.env))
  const native = new Set(input.configDir ? await toolNamesInDir(input.configDir) : [])
  const bridged = tools.filter((tool) => !native.has(tool.name))
  if (bridged.length < tools.length) {
    logger.info('[opencode] the config dir defines these tools itself; its files win', { tools: tools.filter((tool) => native.has(tool.name)).map((tool) => tool.name) })
  }
  const listPath = path.replace(/\.js$/, '.json')
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(
    listPath,
    JSON.stringify({
      url: `http://127.0.0.1:${input.daemonPort}/kortix/tools/`,
      key: toolBridgeKey(input.env),
      tools: bridged.map(({ name, description, parameters }) => ({ name, description, parameters })),
    }),
    { mode: 0o600 },
  )
  writeFileSync(path, toolBridgeSource(listPath), { mode: 0o644 })
  return `file://${path}`
}

function compiledTools(env: NodeJS.ProcessEnv): Partial<CompiledAgentSet> | null {
  try {
    return JSON.parse(env.KORTIX_COMPILED_AGENT_CONFIG ?? 'null') as Partial<CompiledAgentSet> | null
  } catch {
    return null
  }
}
