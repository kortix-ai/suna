import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildOpencodeConfigContent, capabilityToolRules, denyBuiltinSkills } from '@/harness/open-code/lifecycle'
import { LLM_PROXY_PLACEHOLDER_KEY } from '@/services/llm-proxy/llm-proxy'
import { v3OpencodeEnv } from '@/harness/open-code/manifest-v3'
import { encodeCompiledAgentConfigEnv } from '@kortix/api-contract/compiled-agent-config-env'

const ENV = { KORTIX_TOKEN: 'tok-123', KORTIX_API_URL: 'https://api.kortix.test/v1' }

const GATEWAY_CATALOG = {
  'anthropic/claude-opus-4.8': { name: 'Claude Opus 4.8', provider: 'anthropic', reasoning: true, tool_call: true, attachment: true, temperature: true },
  'anthropic/claude-sonnet-4.6': { name: 'Claude Sonnet 4.6', reasoning: true, tool_call: true, attachment: true },
  'codex/gpt-5.6-sol': { name: 'GPT-5.6 Sol', reasoning: true, tool_call: true },
  'deepseek/deepseek-v4-flash': { name: 'DeepSeek V4 Flash', reasoning: true, tool_call: true },
  'x-ai/grok-4.3': { name: 'Grok 4.3', tool_call: true },
  'minimax/minimax-m3': { name: 'Minimax M3', tool_call: true },
}

const realFetch = globalThis.fetch

const CATALOG_FILE = join(mkdtempSync(join(tmpdir(), 'kortix-mcp-catalog-')), 'catalog.json')

function stageGatewayCatalog(catalog: Record<string, unknown>) {
  writeFileSync(CATALOG_FILE, JSON.stringify({ models: catalog }))
  globalThis.fetch = (async (input: string) => {
    throw new Error(`boot config must not fetch; attempted ${String(input)}`)
  }) as unknown as typeof fetch
}

afterEach(() => {
  globalThis.fetch = realFetch
})

describe('buildOpencodeConfigContent — injected managed skills', () => {
  test('declares the injected skills dir via skills.paths', async () => {
    const dir = join(tmpdir(), `kortix-skills-test-${process.pid}`)
    const { mkdirSync } = await import('node:fs')
    mkdirSync(dir, { recursive: true })
    const content = await buildOpencodeConfigContent({}, { injectedSkillsDir: dir })
    const parsed = JSON.parse(content!)
    expect(parsed.skills.paths).toContain(dir)
  })

  test('merges with skills paths already declared by the compiled config', async () => {
    const dir = join(tmpdir(), `kortix-skills-test-${process.pid}`)
    const { mkdirSync } = await import('node:fs')
    mkdirSync(dir, { recursive: true })
    const content = await buildOpencodeConfigContent(
      { KORTIX_COMPILED_AGENT_CONFIG: JSON.stringify({ skills: { paths: ['/repo/skills'] } }) },
      { injectedSkillsDir: dir },
    )
    const parsed = JSON.parse(content!)
    expect(parsed.skills.paths).toEqual(['/repo/skills', dir])
  })

  test('declares the project root skills/ after the injected dir, without duplicates', async () => {
    const { mkdirSync } = await import('node:fs')
    const injected = join(tmpdir(), `kortix-skills-injected-${process.pid}`)
    const project = join(tmpdir(), `kortix-skills-project-${process.pid}`)
    mkdirSync(injected, { recursive: true })
    mkdirSync(project, { recursive: true })
    const parsed = JSON.parse(
      (await buildOpencodeConfigContent(
        { KORTIX_COMPILED_AGENT_CONFIG: JSON.stringify({ skills: { paths: [project] } }) },
        { injectedSkillsDir: injected, projectSkillsDir: project },
      ))!,
    )
    expect(parsed.skills.paths).toEqual([project, injected])
  })

  test('a missing project skills dir contributes nothing', async () => {
    const parsed = JSON.parse(
      (await buildOpencodeConfigContent({}, { projectSkillsDir: '/nonexistent-project-skills' }))!,
    )
    expect(parsed.skills).toBeUndefined()
  })

  test('a missing injected dir contributes nothing', async () => {
    const parsed = JSON.parse(
      (await buildOpencodeConfigContent({}, { injectedSkillsDir: '/nonexistent-skills-dir' }))!,
    )
    expect(parsed.skills).toBeUndefined()
  })

  test('loads the generated secret capability guide without replacing project instructions', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'kortix-secret-guide-')), 'capabilities.md')
    writeFileSync(file, '# Secret capabilities\n')
    const content = await buildOpencodeConfigContent(
      { OPENCODE_CONFIG_CONTENT: JSON.stringify({ instructions: ['/workspace/AGENTS.md'] }) },
      { secretCapabilitiesInstructionPath: file },
    )
    expect(JSON.parse(content!).instructions).toEqual(['/workspace/AGENTS.md', file])
  })

  // The genui flag is applied by withholding the skill files (managed-skills-genui-flag.test.ts): a
  // project's `"*": "allow"` merges after this config and outranks any skill rule written here.
  test('either flag value: no kortix-genui permission rule, and no instruction file carries the catalog', async () => {
    for (const flag of ['0', '1']) {
      const out = JSON.parse((await buildOpencodeConfigContent({ ...ENV, KORTIX_GENUI: flag }))!)
      expect(out.permission.skill).toEqual({ 'customize-opencode': 'deny' })
      expect(JSON.stringify(out.instructions ?? [])).not.toContain('genui')
    }
  })
})

describe('buildOpencodeConfigContent — base composition', () => {
  test('registers no Kortix MCP server, also when an older API still sends KORTIX_CONNECTORS_MCP_ENABLED', async () => {
    // The in-sandbox `kortix-connectors` MCP is gone: agents use the `kortix` CLI.
    for (const env of [ENV, { ...ENV, KORTIX_CONNECTORS_MCP_ENABLED: '1' }]) {
      expect(JSON.parse((await buildOpencodeConfigContent(env))!).mcp).toBeUndefined()
    }
  })

  test('registers nothing session-specific when no contributor applies', async () => {
    for (const env of [{}, ENV]) {
      const parsed = JSON.parse((await buildOpencodeConfigContent(env))!)
      expect(parsed.mcp).toBeUndefined()
      expect(parsed.provider).toBeUndefined()
    }
  })

  test('always disables OpenCode autoupdate — the daemon owns the binary', async () => {
    // A human running `opencode` in the Session terminal triggered OpenCode's
    // own upgrade (plain `pnpm add -g`, no postinstall) on two SampleCo boxes
    // on 2026-08-25, leaving a 479-byte launcher stub and a dangling
    // /opt/kortix/opencode.current. The next OpenCode restart would have booted
    // the stub. Every composed config now pins autoupdate off, and a base
    // config cannot turn it back on.
    for (const env of [{}, ENV]) {
      expect(JSON.parse((await buildOpencodeConfigContent(env))!).autoupdate).toBe(false)
    }
    const parsed = JSON.parse(
      (await buildOpencodeConfigContent({ OPENCODE_CONFIG_CONTENT: JSON.stringify({ autoupdate: true }) }))!,
    )
    expect(parsed.autoupdate).toBe(false)
  })

  test('merges onto pre-existing inline config without clobbering it', async () => {
    const existing = JSON.stringify({
      theme: 'dark',
      mcp: { other: { type: 'local', command: ['echo'], enabled: true } },
    })
    const config = JSON.parse((await buildOpencodeConfigContent({ ...ENV, OPENCODE_CONFIG_CONTENT: existing }))!)
    expect(config.theme).toBe('dark')
    expect(Object.keys(config.mcp)).toEqual(['other'])
  })

  test('survives malformed pre-existing inline config', async () => {
    const config = JSON.parse((await buildOpencodeConfigContent({ ...ENV, OPENCODE_CONFIG_CONTENT: 'not json{' }))!)
    expect(config.autoupdate).toBe(false)
  })
})

describe('buildOpencodeConfigContent — Kortix LLM gateway provider', () => {
  const GATEWAY_ENV = {
    KORTIX_LLM_BASE_URL: 'https://api.kortix.test/v1/llm',
    KORTIX_TOKEN: 'kyolo_abc123',
    KORTIX_LLM_CATALOG_FILE: CATALOG_FILE,
  }

  test('registers the kortix provider when gateway env present', async () => {
    stageGatewayCatalog(GATEWAY_CATALOG)
    const config = JSON.parse((await buildOpencodeConfigContent(GATEWAY_ENV))!)
    expect(config.provider.kortix).toMatchObject({
      npm: '@ai-sdk/openai-compatible',
      name: 'Kortix',
      options: {
        baseURL: 'https://api.kortix.test/v1/llm',
        apiKey: 'kyolo_abc123',
      },
    })
    expect(Object.keys(config.provider.kortix.models).length).toBeGreaterThan(0)
  })

  test('populates the provider models from the baked catalog file', async () => {
    stageGatewayCatalog(GATEWAY_CATALOG)
    const config = JSON.parse((await buildOpencodeConfigContent(GATEWAY_ENV))!)
    const models = config.provider.kortix.models
    expect(models['anthropic/claude-opus-4.8'].reasoning).toBe(true)
    expect(models['anthropic/claude-sonnet-4.6'].reasoning).toBe(true)
    expect(models['deepseek/deepseek-v4-flash'].reasoning).toBe(true)
    expect(models['x-ai/grok-4.3'].tool_call).toBe(true)
    expect(models['minimax/minimax-m3'].tool_call).toBe(true)
    // `provider` is picker metadata from the Kortix catalog, not part of an
    // OpenCode custom-provider model definition. OpenCode 1.1.25+ treats that
    // field as a nested provider override and rejects string values at startup.
    expect(models['anthropic/claude-opus-4.8'].provider).toBeUndefined()
  })

  test('uses the resolved session model as the OpenCode default', async () => {
    stageGatewayCatalog(GATEWAY_CATALOG)
    const config = JSON.parse((await buildOpencodeConfigContent({
      ...GATEWAY_ENV,
      KORTIX_OPENCODE_MODEL: 'codex/gpt-5.6-sol',
    }))!)
    expect(config.model).toBe('kortix/codex/gpt-5.6-sol')
    expect(config.small_model).toBe('kortix/codex/gpt-5.6-sol')
  })

  test('uses an available gateway model for legacy sessions without a resolved model', async () => {
    stageGatewayCatalog(GATEWAY_CATALOG)
    const config = JSON.parse((await buildOpencodeConfigContent(GATEWAY_ENV))!)
    expect(config.model).toBe('kortix/anthropic/claude-opus-4.8')
    expect(config.small_model).toBe('kortix/anthropic/claude-opus-4.8')
  })

  test('routes a user-set default model through the Kortix provider', async () => {
    stageGatewayCatalog(GATEWAY_CATALOG)
    const existing = JSON.stringify({ model: 'anthropic/claude-sonnet-4.6' })
    const config = JSON.parse(
      (await buildOpencodeConfigContent({ ...GATEWAY_ENV, OPENCODE_CONFIG_CONTENT: existing }))!,
    )
    expect(config.model).toBe('kortix/anthropic/claude-sonnet-4.6')
  })

  test('merges provider onto pre-existing inline provider block', async () => {
    stageGatewayCatalog(GATEWAY_CATALOG)
    const existing = JSON.stringify({
      provider: { anthropic: { options: { timeout: 600000 } } },
    })
    const config = JSON.parse(
      (await buildOpencodeConfigContent({ ...GATEWAY_ENV, OPENCODE_CONFIG_CONTENT: existing }))!,
    )
    expect(config.provider.anthropic).toBeDefined()
    expect(config.provider.kortix).toBeDefined()
  })
})

describe('buildOpencodeConfigContent — gateway provider allowlist', () => {
  const GATEWAY_ENV = {
    KORTIX_LLM_BASE_URL: 'https://api.kortix.test/v1/llm',
    KORTIX_TOKEN: 'kyolo_abc123',
    KORTIX_LLM_CATALOG_FILE: CATALOG_FILE,
  }

  test('allows only kortix when the gateway is active', async () => {
    stageGatewayCatalog(GATEWAY_CATALOG)
    const config = JSON.parse((await buildOpencodeConfigContent(GATEWAY_ENV))!)
    expect(config.enabled_providers).toEqual(['kortix'])
  })

})

describe('buildOpencodeConfigContent — Slack sessions deny the question tool', () => {
  test.each([
    ['a Slack thread', { ...ENV, SLACK_THREAD_TS: '1700000000.0001' }],
    ['a Slack channel', { ...ENV, SLACK_CHANNEL_ID: 'C123' }],
    ['a Slack channel with no connector or gateway env', { SLACK_CHANNEL_ID: 'C123' }],
  ])('denies `question` for %s', async (_name, env) => {
    const config = JSON.parse((await buildOpencodeConfigContent(env))!)
    expect(config.permission.question).toBe('deny')
  })

  test('does NOT touch permissions for a non-Slack (web) session — tool stays native', async () => {
    const config = JSON.parse((await buildOpencodeConfigContent(ENV))!)
    expect(config.permission?.question).toBeUndefined()
  })

  test('merges the deny onto a pre-existing permission block', async () => {
    const existing = JSON.stringify({ permission: { bash: 'ask' } })
    const config = JSON.parse(
      (await buildOpencodeConfigContent({ ...ENV, SLACK_THREAD_TS: '1700000000.0001', OPENCODE_CONFIG_CONTENT: existing }))!,
    )
    expect(config.permission.bash).toBe('ask')
    expect(config.permission.question).toBe('deny')
  })
})

describe('buildOpencodeConfigContent — server-compiled v2 agent config (KORTIX_COMPILED_AGENT_CONFIG)', () => {
  const GATEWAY_ENV = {
    KORTIX_LLM_BASE_URL: 'https://api.kortix.test/v1/llm',
    KORTIX_TOKEN: 'kyolo_abc123',
    KORTIX_LLM_CATALOG_FILE: CATALOG_FILE,
  }
  const COMPILED = JSON.stringify({
    model: 'anthropic/claude-sonnet-5',
    agent: {
      support: { mode: 'primary', model: 'anthropic/claude-sonnet-5', prompt: 'Triage support tickets.' },
    },
  })

  test('builds a config from the compiled agent config alone (no connector/gateway/Slack)', async () => {
    const config = JSON.parse((await buildOpencodeConfigContent({ KORTIX_COMPILED_AGENT_CONFIG: COMPILED }))!)
    expect(config.model).toBe('anthropic/claude-sonnet-5')
    expect(config.agent.support).toEqual({
      mode: 'primary',
      model: 'anthropic/claude-sonnet-5',
      prompt: 'Triage support tickets.',
    })
  })

  // Platinum prod, 2026-10-14: a create whose `KORTIX_COMPILED_AGENT_CONFIG=…\0` was over
  // 131,072 bytes never booted. The API now sends such a config gzip-encoded in parts.
  test('a compiled config over the exec limit arrives gzip-encoded and composes the same agents', async () => {
    const prompt = `Triage support tickets. ${'Quote the order id and the refund policy section. '.repeat(5_500)}`
    const compiled = JSON.stringify({ model: 'anthropic/claude-sonnet-5', agent: { support: { mode: 'primary', prompt } } })
    const env = encodeCompiledAgentConfigEnv(compiled)
    expect(env).not.toHaveProperty('KORTIX_COMPILED_AGENT_CONFIG')
    expect(env.KORTIX_COMPILED_AGENT_CONFIG_GZ_PARTS).toBe('1')

    const config = JSON.parse((await buildOpencodeConfigContent(env))!)
    expect(config.model).toBe('anthropic/claude-sonnet-5')
    expect(config.agent.support).toEqual({ mode: 'primary', prompt })
  })

  test('a damaged gzip form composes no compiled agents rather than failing the boot', async () => {
    const env = { KORTIX_COMPILED_AGENT_CONFIG_GZ_PARTS: '2', KORTIX_COMPILED_AGENT_CONFIG_GZ_0: 'H4sI' }
    const config = JSON.parse((await buildOpencodeConfigContent(env))!)
    expect(config.agent).toBeUndefined()
  })

  // A Codex wire model keeps its whole ref as the Kortix model id.
  test.each(['anthropic/claude-sonnet-5', 'codex/gpt-5.6-sol'])(
    'the gateway overlay routes the compiled top-level and agent model %j through kortix/',
    async (model) => {
      stageGatewayCatalog(GATEWAY_CATALOG)
      const compiled = JSON.stringify({ model, agent: { support: { mode: 'primary', model } } })
      const config = JSON.parse(
        (await buildOpencodeConfigContent({ ...GATEWAY_ENV, KORTIX_COMPILED_AGENT_CONFIG: compiled }))!,
      )
      expect(config.model).toBe(`kortix/${model}`)
      expect(config.small_model).toMatch(/^kortix\//)
      expect(config.agent.support.model).toBe(`kortix/${model}`)
    },
  )

  test('OPENCODE_CONFIG_CONTENT (repo config) wins over the compiled base on key collision', async () => {
    const existing = JSON.stringify({ model: 'repo/override-model' })
    const config = JSON.parse(
      (await buildOpencodeConfigContent({
        KORTIX_COMPILED_AGENT_CONFIG: COMPILED,
        OPENCODE_CONFIG_CONTENT: existing,
      }))!,
    )
    expect(config.model).toBe('repo/override-model')
    expect(config.agent.support).toBeDefined()
  })

  test('malformed KORTIX_COMPILED_AGENT_CONFIG is ignored, not fatal', async () => {
    const config = await buildOpencodeConfigContent({
      ...ENV,
      KORTIX_COMPILED_AGENT_CONFIG: 'not json{',
    })
    expect(config).toBeDefined()
    expect(JSON.parse(config!).agent).toBeUndefined()
  })
})

describe('buildOpencodeConfigContent — warm-fork proxy mode bakes no session credential', () => {
  // A warm seed has no session token. With the localhost LLM proxy the composed
  // config is session-independent: the proxy injects the live token per request,
  // so a restored fork swaps credentials with no OpenCode restart.
  const PROXY_ENV = {
    KORTIX_LLM_PROXY_URL: 'http://127.0.0.1:4319',
    KORTIX_API_URL: 'https://api.kortix.test/v1',
    KORTIX_LLM_BASE_URL: 'https://gateway.kortix.test/v1/llm',
    KORTIX_TOKEN: 'real-session-token',
    KORTIX_LLM_CATALOG_FILE: CATALOG_FILE,
  }

  test('the gateway provider points at the proxy with the placeholder key', async () => {
    stageGatewayCatalog(GATEWAY_CATALOG)
    const config = JSON.parse((await buildOpencodeConfigContent(PROXY_ENV))!)
    expect(config.provider.kortix.options.baseURL).toBe('http://127.0.0.1:4319')
    expect(config.provider.kortix.options.apiKey).toBe(LLM_PROXY_PLACEHOLDER_KEY)
    expect(JSON.stringify(config)).not.toContain('real-session-token')
    expect(config.mcp).toBeUndefined()
  })
})

describe("OpenCode's built-in customize-opencode skill is denied in every permission block", () => {
  const DENY = { 'customize-opencode': 'deny' }

  test.each([
    ['no block', undefined, { skill: DENY }],
    ['a bare allow keeps every other rule as `*`', 'allow', { '*': 'allow', skill: DENY }],
    ['a bare ask', 'ask', { '*': 'ask', skill: DENY }],
    ['a skill action becomes its `*` form', { bash: 'ask', skill: 'allow' }, { bash: 'ask', skill: { '*': 'allow', ...DENY } }],
    ['a skills grant keeps its entries', { skill: { pdf: 'allow', '*': 'deny' } }, { skill: { pdf: 'allow', '*': 'deny', ...DENY } }],
    ['an explicit allow of the skill is overruled', { skill: { 'customize-opencode': 'allow', '*': 'ask' } }, { skill: { '*': 'ask', ...DENY } }],
  ])('%s', (_name, permission, expected) => {
    expect(denyBuiltinSkills(permission)).toEqual(expected)
  })

  test('the deny is the last skill rule and skill is the last key: OpenCode lets the last match win', () => {
    const rules = denyBuiltinSkills({ skill: { 'customize-opencode': 'allow', '*': 'allow' }, bash: 'allow' }) as Record<string, Record<string, string>>
    expect(Object.keys(rules).at(-1)).toBe('skill')
    expect(Object.keys(rules.skill!).at(-1)).toBe('customize-opencode')
  })

  test('a block that already denies every skill is left alone', () => {
    expect(denyBuiltinSkills('deny')).toBe('deny')
    expect(denyBuiltinSkills({ skill: 'deny', bash: 'allow' })).toEqual({ skill: 'deny', bash: 'allow' })
    expect(denyBuiltinSkills({ '*': 'deny' })).toEqual({ '*': 'deny' })
  })

  test('the composed config carries it globally and on an agent whose own block would outrank the global one', async () => {
    const content = await buildOpencodeConfigContent({
      KORTIX_COMPILED_AGENT_CONFIG: JSON.stringify({ permission: 'allow', agent: { open: { permission: 'allow' }, plain: { mode: 'primary' } } }),
    } as never)
    const config = JSON.parse(content!) as { permission: unknown; agent: Record<string, { permission?: unknown }> }
    expect(config.permission).toEqual({ '*': 'allow', skill: DENY })
    expect(config.agent.open!.permission).toEqual({ '*': 'allow', skill: DENY })
    expect(config.agent.plain!.permission).toBeUndefined()
  })
})

describe('capability rules reach the tools that cannot ask (E9)', () => {
  const PTY = ['pty_spawn', 'pty_write', 'pty_read', 'pty_list', 'pty_kill']

  test.each([
    ['a bash deny denies every pty tool', { bash: 'deny' }, 'deny'],
    ['a bash ask denies them: they cannot ask', { bash: 'ask' }, 'deny'],
    ['a bash pattern map denies them: they cannot match patterns', { bash: { 'git *': 'allow', '*': 'deny' } }, 'deny'],
    ['a bash allow allows them', { bash: 'allow' }, 'allow'],
  ] as const)('%s', (_name, permission, expected) => {
    const rules = capabilityToolRules(permission) as Record<string, unknown>
    for (const tool of PTY) expect(rules[tool]).toBe(expected)
  })

  test('web search and scrape tools follow websearch and webfetch', () => {
    expect(capabilityToolRules({ websearch: 'deny', webfetch: 'ask' })).toMatchObject({
      web_search: 'deny',
      image_search: 'deny',
      scrape_webpage: 'deny',
    })
  })

  test('no capability rule, a bare action, or a tool rule of its own is left alone', () => {
    expect(capabilityToolRules({ edit: 'deny' })).toEqual({ edit: 'deny' })
    expect(capabilityToolRules('deny')).toBe('deny')
    expect(capabilityToolRules(undefined)).toBeUndefined()
    expect(capabilityToolRules({ bash: 'deny', pty_read: 'allow' })).toMatchObject({ pty_read: 'allow', pty_spawn: 'deny' })
  })

  test('the composed config applies it to every compiled agent and keeps the Slack question deny', async () => {
    const compiled = JSON.stringify({
      agent: { locked: { mode: 'primary', permission: { bash: 'deny', edit: 'deny' } }, open: { mode: 'primary' } },
    })
    const config = JSON.parse(
      (await buildOpencodeConfigContent({ KORTIX_COMPILED_AGENT_CONFIG: compiled, SLACK_CHANNEL_ID: 'C123' }))!,
    )
    expect(config.agent.locked.permission).toMatchObject({ bash: 'deny', edit: 'deny', pty_spawn: 'deny', pty_kill: 'deny' })
    expect(config.agent.open.permission).toBeUndefined()
    expect(config.permission).toEqual({ question: 'deny', skill: { 'customize-opencode': 'deny' } })
  })
})

describe('buildOpencodeConfigContent — kortix.yaml v3 (schema: 3)', () => {
  // The config root: the active release root, else /workspace.
  const root = mkdtempSync(join(tmpdir(), 'kortix-v3-root-'))
  for (const dir of ['skills/research', 'skills/unregistered', 'ext']) mkdirSync(join(root, dir), { recursive: true })
  writeFileSync(join(root, 'skills/research/SKILL.md'), '---\nname: research\ndescription: d\n---\n')
  writeFileSync(join(root, 'ext/audit.ts'), 'export default async () => ({})\n')
  writeFileSync(join(root, 'ext/other.ts'), 'export default async () => ({})\n')
  const injected = mkdtempSync(join(tmpdir(), 'kortix-v3-managed-'))

  const SET = {
    schema: 3,
    default_agent: 'lead',
    agent: {
      lead: { mode: 'primary', prompt: 'Lead.', extensions: ['audit', 'gone', 'pi-only'], permission: { '*': 'allow' } },
      helper: { mode: 'subagent', prompt: 'Help.', extensions: ['other'], codemode: 'off' },
      build: { disable: true },
      plan: { disable: true },
      general: { disable: true },
      explore: { disable: true },
    },
    skills: { research: 'skills/research', notes: 'docs/notes' },
    commands: {
      weekly: { description: 'Weekly summary', template: 'Summarize $ARGUMENTS', agents: ['lead'] },
      triage: { template: 'Triage $1', agents: ['lead', 'helper'] },
    },
    extensions: {
      audit: { opencode: 'ext/audit.ts' },
      gone: { opencode: 'ext/missing.ts' },
      'pi-only': { pi: 'npm:pi-thing@1.0.0' },
      other: { opencode: 'ext/other.ts' },
    },
  }
  const build = async (env: Record<string, string> = {}, set: Record<string, unknown> = SET) =>
    JSON.parse(
      (await buildOpencodeConfigContent(
        { KORTIX_COMPILED_AGENT_CONFIG: JSON.stringify(set), ...env },
        { configRoot: root, injectedSkillsDir: injected, projectSkillsDir: join(root, 'skills') },
      ))!,
    )

  test('OpenCode never sees the Kortix-only keys', async () => {
    const config = await build()
    expect(config.schema).toBeUndefined()
    expect(config.commands).toBeUndefined()
    expect(config.extensions).toBeUndefined()
    expect(Object.keys(config.skills)).toEqual(['paths'])
    expect(config.agent.lead.extensions).toBeUndefined()
    expect(config.agent.helper.extensions).toBeUndefined()
    expect(config.agent.helper.codemode).toBeUndefined()
  })

  test('the built-in agents stay disabled, so the task tool cannot offer them', async () => {
    const config = await build()
    for (const name of ['build', 'plan', 'general', 'explore']) expect(config.agent[name]).toEqual({ disable: true })
  })

  test('commands compile into OpenCode `command`: template and description, no agents', async () => {
    expect((await build()).command).toEqual({
      weekly: { template: 'Summarize $ARGUMENTS', description: 'Weekly summary' },
      triage: { template: 'Triage $1' },
    })
  })

  test('skills.paths: exactly the registered folders that exist, then the managed overlay; no skills/ discovery', async () => {
    expect((await build()).skills.paths).toEqual([join(root, 'skills/research'), injected])
  })

  test("plugins: the session agent's OpenCode extensions as file:// specs; a missing file is skipped", async () => {
    const plugins: string[] = (await build()).plugin
    expect(plugins).toContain(`file://${join(root, 'ext/audit.ts')}`)
    expect(plugins.some((spec) => spec.includes('missing.ts'))).toBe(false)
    expect(plugins.some((spec) => spec.includes('other.ts'))).toBe(false)
  })

  test('KORTIX_AGENT_NAME picks the session agent, and with it the plugins', async () => {
    const plugins: string[] = (await build({ KORTIX_AGENT_NAME: 'helper' })).plugin
    expect(plugins).toEqual([`file://${join(root, 'ext/other.ts')}`])
  })

  test('an agent with no extensions loads no project plugin', async () => {
    const set = { ...SET, agent: { ...SET.agent, lead: { mode: 'primary', prompt: 'Lead.' } } }
    expect((await build({}, set)).plugin).toBeUndefined()
  })

  test('OPENCODE_CONFIG_CONTENT from the environment is not read: the compiled set is the only input', async () => {
    const config = await build({ OPENCODE_CONFIG_CONTENT: JSON.stringify({ model: 'repo/override', command: { x: { template: 'y' } } }) })
    expect(config.model).toBeUndefined()
    expect(Object.keys(config.command)).toEqual(['weekly', 'triage'])
  })

  test('v2 is unchanged: no schema, its keys and the project skills/ dir stay as they were', async () => {
    const v2 = { agent: { support: { mode: 'primary', prompt: 'x' } }, skills: { paths: ['/repo/skills'] } }
    const config = JSON.parse(
      (await buildOpencodeConfigContent(
        { KORTIX_COMPILED_AGENT_CONFIG: JSON.stringify(v2), KORTIX_AGENT_NAME: 'support' },
        { configRoot: root, injectedSkillsDir: injected, projectSkillsDir: join(root, 'skills') },
      ))!,
    )
    expect(config.skills.paths).toEqual(['/repo/skills', injected, join(root, 'skills')])
    expect(config.command).toBeUndefined()
    expect(config.plugin).toBeUndefined()
  })
})

describe('v3OpencodeEnv — OpenCode discovers no project config for a v3 session', () => {
  test('v3 turns off project config and external skill discovery; v1/v2 keep both', () => {
    expect(v3OpencodeEnv({ KORTIX_COMPILED_AGENT_CONFIG: JSON.stringify({ schema: 3, agent: {} }) })).toEqual({
      OPENCODE_DISABLE_PROJECT_CONFIG: '1',
      OPENCODE_DISABLE_EXTERNAL_SKILLS: '1',
    })
    expect(v3OpencodeEnv({ KORTIX_COMPILED_AGENT_CONFIG: JSON.stringify({ agent: {} }) })).toEqual({})
    expect(v3OpencodeEnv({})).toEqual({})
  })
})

describe('kortix.yaml v3 over 128 KiB (gzip parts in env)', () => {
  test('a large v3 set is still v3: no project config, no project config dir', async () => {
    const { compiledV3 } = await import('@/harness/open-code/manifest-v3')
    const prompt = 'x'.repeat(200 * 1024)
    const set = { schema: 3, default_agent: 'lead', agent: { lead: { mode: 'primary', prompt } } }
    const env = encodeCompiledAgentConfigEnv(JSON.stringify(set))
    expect(env.KORTIX_COMPILED_AGENT_CONFIG).toBeUndefined()
    expect(compiledV3(env as NodeJS.ProcessEnv)?.schema).toBe(3)
    expect(v3OpencodeEnv(env as NodeJS.ProcessEnv)).toEqual({ OPENCODE_DISABLE_PROJECT_CONFIG: '1', OPENCODE_DISABLE_EXTERNAL_SKILLS: '1' })
  })
})
