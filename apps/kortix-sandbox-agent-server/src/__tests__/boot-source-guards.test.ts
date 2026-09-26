/**
 * Ordering contracts inside `harness/open-code/boot.ts` (and the one boot path it
 * hands the clone to, `boot-config-path.ts`) that no behavioral test reaches yet.
 *
 * `startSessionRuntime` and `maybeCreateInitialOpencodeSession` are private and
 * run only inside a full boot. Until a boot keeper drives them over a fake
 * OpenCode and a fake API, these source guards are the cheapest independent
 * proof of each ordering below; every one of them names the incident it
 * prevents. They are the ONLY source-text assertions allowed on boot.ts.
 *
 * Rules for this file:
 * - Read sources through `stripComments()` first. A guard that
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
const BOOT_PATH = stripComments(
  readFileSync(join(import.meta.dir, '..', 'harness', 'open-code', 'boot-config-path.ts'), 'utf8'),
)

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
  test('the LLM proxy is up before OpenCode can spawn', () => {
    // OpenCode's provider baseURL points at the local proxy; a spawn before it
    // listens boots a provider map that answers nothing.
    expectOrder(BOOT, [
      'const llmUrl = startLlmProxy(',
      'process.env.KORTIX_LLM_PROXY_URL = llmUrl',
      'await bootOpenCodeConfig({',
    ])
  })

  test('OpenCode spawns before the checkout completes: the clone is handed over, never awaited here', () => {
    // Waiting for the checkout before the spawn cost the whole clone on every
    // boot. The boot path owns the clone promise and starts OpenCode first.
    expect(BOOT).not.toContain('await repoMaterializePromise')
    const bootPath = BOOT.indexOf('await bootOpenCodeConfig({')
    expect(bootPath).toBeGreaterThan(BOOT.indexOf('const repoMaterializePromise'))
    expect(BOOT.slice(bootPath, BOOT.indexOf('onReady:', bootPath))).toContain('workspace: repoMaterializePromise')
    expectOrder(BOOT_PATH, ['const started = input.start()', 'await input.workspace'])
  })

  test('the workspace gate is closed before the lifecycle exists', () => {
    // An Instance created before the checkout keeps a tool registry whose
    // imports failed, for the life of the process. Where the gate opens (once,
    // after the proof) is boot-path-tripwire T3.
    expectOrder(BOOT, ['bootState.workspaceReady = false', 'const harness = createOpenCodeHarnessService('])
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

  test('both runtime-ready exits run the one ready tail: boot projection push and config convergence', () => {
    expect(runtime.split('runtimeReadyTail(opencode, cfg, bootState, bootMark)').length - 1).toBe(2)
    const tail = fn('function runtimeReadyTail(')
    expect(tail).toContain("scheduleRuntimeProjectionPush('boot')")
    expect(tail).toContain('scheduleConvergenceAfterReady(opencode, cfg, bootMark)')
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
