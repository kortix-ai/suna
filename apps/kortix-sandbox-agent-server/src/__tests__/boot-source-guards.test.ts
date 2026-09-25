/**
 * Ordering contracts inside `harness/open-code/boot.ts` that no behavioral test
 * reaches yet.
 *
 * `startSessionRuntime` and `maybeCreateInitialOpencodeSession` are private and
 * run only inside a full boot. Until a boot keeper drives them over a fake
 * OpenCode and a fake API, these source guards are the cheapest independent
 * proof of each ordering below; every one of them names the incident it
 * prevents. They are the ONLY source-text assertions allowed on boot.ts.
 *
 * Rules for this file:
 * - Read boot.ts through `code()`, which strips comments first. A guard that
 *   matched a word inside a comment once passed with the `return` it named
 *   deleted from the code.
 * - Anchor each assertion inside the function or block that owns it.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** Source with `//` and `/* *\/` comments removed; string and template literal
 *  contents (URLs included) are kept. */
function stripComments(src: string): string {
  let out = ''
  let i = 0
  let quote: string | null = null
  while (i < src.length) {
    const ch = src[i]!
    const next = src[i + 1]
    if (quote) {
      out += ch
      if (ch === '\\') {
        out += next ?? ''
        i += 2
        continue
      }
      if (ch === quote) quote = null
      i += 1
      continue
    }
    if (ch === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') i += 1
      continue
    }
    if (ch === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2)
      i = end < 0 ? src.length : end + 2
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') quote = ch
    out += ch
    i += 1
  }
  return out
}

const BOOT = stripComments(readFileSync(join(import.meta.dir, '..', 'harness', 'open-code', 'boot.ts'), 'utf8'))

/** The text of one top-level function, from its declaration to the next one. */
function fn(signature: string): string {
  const start = BOOT.indexOf(signature)
  expect(start).toBeGreaterThan(-1)
  const next = BOOT.slice(start + signature.length).search(/\n(export )?(async )?function |\nexport \{/)
  return next < 0 ? BOOT.slice(start) : BOOT.slice(start, start + signature.length + next)
}

/** Every index of `needle` must be > -1 and strictly increasing. */
function expectOrder(body: string, needles: string[]): void {
  let at = -1
  for (const needle of needles) {
    const found = body.indexOf(needle, at + 1)
    expect({ needle, found: found > at }).toEqual({ needle, found: true })
    at = found
  }
}

describe('runOpenCode: early spawn', () => {
  test('the LLM proxy is up before compiled OpenCode spawns', () => {
    // OpenCode's provider baseURL points at the local proxy; a spawn before it
    // listens boots a provider map that answers nothing.
    expectOrder(BOOT, [
      'const llmUrl = startLlmProxy(',
      'process.env.KORTIX_LLM_PROXY_URL = llmUrl',
      'const compiledOpencodeStartPromise',
      'await opencode.start()',
    ])
  })

  test('compiled OpenCode starts before the checkout is awaited', () => {
    // The compiled config needs no checkout; waiting for it cost the whole
    // clone on every compiled boot.
    const repo = BOOT.indexOf('const repoMaterializePromise')
    const compiledStart = BOOT.indexOf('const compiledOpencodeStartPromise', repo)
    const checkoutWait = BOOT.indexOf('await repoMaterializePromise', compiledStart)
    expect(repo).toBeGreaterThan(-1)
    expect(compiledStart).toBeGreaterThan(repo)
    expect(checkoutWait).toBeGreaterThan(compiledStart)
    expect(BOOT.slice(compiledStart, checkoutWait)).toContain('await opencode.start()')
  })

  test('the workspace gate closes only for an early spawn and opens only once the workspace is complete', () => {
    // An Instance created before the checkout keeps a tool registry whose
    // imports failed, for the life of the process. The gate was once opened
    // right after start(), which made the fix inert (the gate opened ~170 ms
    // before the checkout landed).
    expect(BOOT).toContain('if (earlyOpencodeConfigDir) bootState.workspaceReady = false')
    const early = BOOT.slice(
      BOOT.indexOf('const earlyOpencodeStartPromise'),
      BOOT.indexOf('const compiledOpencodeConfigDir'),
    )
    expect(early).not.toContain('markWorkspaceReady')
    expectOrder(BOOT, [
      'await ensureOpencodeConfigDeps(opencodeConfigDir)',
      'await ensureInjectedManagedSkills(opencodeConfigDir)',
      'harness.configuration.reconfigure(cfg, opencodeConfigDir, projectEnv)',
      'opencode.markWorkspaceReady()',
      'const reloaded = await harness.configuration.reloadForWorkspace()',
      'await opencode.restart()',
    ])
  })
})

describe('startSessionRuntime', () => {
  const runtime = fn('async function startSessionRuntime(')

  test('subscribes to events before resolving the root, without awaiting the handshake', () => {
    // A fast first turn finished before the subscription and its idle was
    // lost; awaiting the handshake deadlocks with prompt delivery.
    const subscribeAt = runtime.indexOf('harness.events.subscribe(cfg, eventHandlers)')
    const attemptAt = runtime.indexOf('await attemptInitialSession()', subscribeAt)
    expect(subscribeAt).toBeGreaterThan(-1)
    expect(attemptAt).toBeGreaterThan(subscribeAt)
    expect(runtime.slice(subscribeAt, attemptAt)).not.toContain('await harness.events.subscribe')
  })

  test('both runtime-ready exits run the one ready tail, and it pushes the boot projection', () => {
    expect(runtime.split('runtimeReadyTail(cfg, bootState)').length - 1).toBe(2)
    expect(fn('function runtimeReadyTail(')).toContain("scheduleRuntimeProjectionPush('boot')")
  })
})

describe('maybeCreateInitialOpencodeSession', () => {
  const initial = fn('async function maybeCreateInitialOpencodeSession(')

  test('resolves the live URL after the listening gate, before the root lookup', () => {
    // A verified reload during the wait moves the port; a URL read before the
    // gate asks a retired process.
    expect(initial).toContain('firstListening: opencode.waitForCurrentListening()')
    expectOrder(initial, [
      'await waitForOpencodeRootReadiness(',
      'const baseUrl = opencode.getInternalUrl()',
      'await resolveExistingRoot(',
      "bootMark('opencode-answering')",
    ])
  })

  test('a deferred root lookup returns before creating or pinning anything', () => {
    // A slow OpenCode after resume with a pinned root must not get a
    // competing root that orphans the pinned conversation.
    const deferAt = initial.indexOf("if (resolved.status === 'defer') {")
    expect(deferAt).toBeGreaterThan(-1)
    const block = initial.slice(deferAt, initial.indexOf('\n  }\n', deferAt))
    expect(block).toMatch(/\n\s+return\s*$/)
    expect(block).not.toContain('createInitialOpenCodeSession(')
    expect(block).not.toContain('pinOpencodeSessionFile(')
    expect(initial.indexOf('createInitialOpenCodeSession(')).toBeGreaterThan(deferAt)
    expect(initial.indexOf('pinOpencodeSessionFile(')).toBeGreaterThan(deferAt)
  })

  test('delivery is gated on what a PRIOR boot recorded, read before this boot writes', () => {
    // A boot that read its own pin or marker as proof of delivery would
    // silence the session forever.
    expect(initial).toContain(
      'alreadyDelivered = reusedRootAlreadyDelivered(existing, priorPin, priorDeliveredMarker)',
    )
    const resolveAt = initial.indexOf('await resolveExistingRoot(')
    for (const read of ['const priorPin = readOpenCodeSessionPin()', 'const priorDeliveredMarker = readInitialPromptDeliveredMarker()']) {
      const at = initial.indexOf(read)
      expect({ read, beforeResolve: at > -1 && at < resolveAt }).toEqual({ read, beforeResolve: true })
    }
    expect(initial.indexOf('pinOpencodeSessionFile(')).toBeGreaterThan(resolveAt)
    expect(initial.indexOf('markInitialPromptDelivered()')).toBeGreaterThan(resolveAt)
  })

  test('the delivery marker is written only after the prompt was accepted', () => {
    // The marker is the receipt of delivery; written earlier, a crash between
    // the two leaves a session that never gets its first prompt.
    expectOrder(initial, ['await publishInitialOpenCodeSessionAfterPrompt(', 'markInitialPromptDelivered()'])
  })
})
