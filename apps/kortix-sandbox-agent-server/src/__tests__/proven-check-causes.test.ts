/**
 * The proven check names the CAUSE of a failure and fails fast.
 *
 * The answers below are the shapes real OpenCode 1.18.31 returns (probed
 * 2026-09-22 against `opencode serve`):
 *   - a syntax error in opencode.jsonc: every directory route, `POST /session`
 *     included, answers 400 `{"name":"ConfigJsonError","data":{path,message}}`;
 *   - a plugin that throws at import: `GET /session` answers 200, while
 *     `/config`, `/agent` and `/experimental/tool/ids` never answer;
 *   - a tool that throws at import: `/config` and `/agent` answer 200,
 *     `/experimental/tool/ids` answers 500 `{"name":"UnknownError",...}`.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { describeOpencodeError, provenCheck } from '../harness/open-code/proven-check'

// `describeOpencodeError` strips a leading `bootLinkPath()`, and that reads
// `KORTIX_BOOT_CONFIG_ROOT` on every call. The expectations below hold for ONE
// root, so this file pins it instead of inheriting whatever the process has:
// in CI run 36153691220 (packages lane) the boot link resolved elsewhere and
// the file was named `boot/opencode.jsonc`. The pin closes the whole class —
// a leaked override from another file, a lane-level variable, an `.env` — and
// costs nothing: the daemon's own default is this path.
const BOOT_CONFIG_ROOT = '/opt/kortix/config'
const savedBootConfigRoot = process.env.KORTIX_BOOT_CONFIG_ROOT
beforeAll(() => {
  process.env.KORTIX_BOOT_CONFIG_ROOT = BOOT_CONFIG_ROOT
})
afterAll(() => {
  if (savedBootConfigRoot === undefined) delete process.env.KORTIX_BOOT_CONFIG_ROOT
  else process.env.KORTIX_BOOT_CONFIG_ROOT = savedBootConfigRoot
})

const RELEASE = `${BOOT_CONFIG_ROOT}/17bf9646cb9e494d7bcef3b1c9994782ec42c5630996a05cb6416a5e320105d5`
const CONFIG_JSON_ERROR = {
  name: 'ConfigJsonError',
  data: {
    path: `${RELEASE}/opencode.jsonc`,
    message:
      '\n--- JSONC Input ---\n{\n  "api_key": "sk-live-SECRET",\n  "subagent_depth": 2,,, THIS IS NOT JSON {{\n}\n\n--- Errors ---\n' +
      'PropertyNameExpected at line 17, column 23\n   Line 17:   "subagent_depth": 2,,, THIS IS NOT JSON {{\n                      ^\n' +
      'InvalidSymbol at line 17, column 26\n   Line 17:   "subagent_depth": 2,,, THIS IS NOT JSON {{\n                         ^\n' +
      'InvalidSymbol at line 17, column 34\n   Line 17: x\n' +
      'ValueExpected at line 20, column 1\n   Line 20: }\n          ^\n--- End ---',
  },
}

let servers: Array<ReturnType<typeof Bun.serve>> = []
afterEach(() => {
  for (const server of servers) server.stop(true)
  servers = []
})

function fakeOpencode(routes: Record<string, () => Response | Promise<Response>>) {
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const route = routes[new URL(req.url).pathname]
      return route ? route() : new Response('not found', { status: 404 })
    },
  })
  servers.push(server)
  return `http://127.0.0.1:${server.port}`
}

describe('describeOpencodeError', () => {
  test('a ConfigJsonError names the file and the first positions, never the file content', () => {
    const cause = describeOpencodeError(400, JSON.stringify(CONFIG_JSON_ERROR), RELEASE)
    expect(cause).toBe(
      'ConfigJsonError in opencode.jsonc: PropertyNameExpected at line 17, column 23; InvalidSymbol at line 17, column 26; InvalidSymbol at line 17, column 34 (+1 more)',
    )
    expect(cause).not.toContain('SECRET')
    expect(cause).not.toContain('THIS IS NOT JSON')
  })

  test('a file read through the boot link is named relative to the config dir (not boot/opencode.jsonc)', () => {
    // The boot-spawned process reads OPENCODE_CONFIG_DIR=/opt/kortix/config/boot,
    // a link to the release; OpenCode reports the path it read.
    const viaLink = {
      ...CONFIG_JSON_ERROR,
      data: { ...CONFIG_JSON_ERROR.data, path: `${BOOT_CONFIG_ROOT}/boot/opencode.jsonc` },
    }
    const cause = describeOpencodeError(400, JSON.stringify(viaLink), RELEASE)
    expect(cause.startsWith('ConfigJsonError in opencode.jsonc: ')).toBe(true)
    const nested = { ...CONFIG_JSON_ERROR, data: { ...CONFIG_JSON_ERROR.data, path: `${BOOT_CONFIG_ROOT}/boot/agents/x.md` } }
    expect(describeOpencodeError(400, JSON.stringify(nested), RELEASE).startsWith('ConfigJsonError in agents/x.md')).toBe(true)
  })

  test('another named error keeps its name, first message line and ref, bounded', () => {
    const cause = describeOpencodeError(
      500,
      JSON.stringify({ name: 'UnknownError', data: { message: `${'x'.repeat(600)}\nsecond line`, ref: 'err_a81809a9' } }),
    )
    expect(cause.startsWith('HTTP 500 UnknownError: xxx')).toBe(true)
    expect(cause).toContain('(ref err_a81809a9)')
    expect(cause).not.toContain('second line')
    expect(cause.length).toBeLessThanOrEqual(300)
  })

  test('a body that is not JSON reports the status only', () => {
    expect(describeOpencodeError(502, '<html>bad gateway</html>')).toBe('HTTP 502')
  })
})

describe('provenCheck fails fast with the cause', () => {
  test('a config error on /config fails at once, not at the deadline', async () => {
    const url = fakeOpencode({ '/config': () => Response.json(CONFIG_JSON_ERROR, { status: 400 }) })
    const started = Date.now()
    const result = await provenCheck(url, Date.now() + 30_000, { directory: '/workspace', toolNames: [], configDir: RELEASE })
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(result).toEqual({
      ok: false,
      fatal: true,
      reason:
        'ConfigJsonError in opencode.jsonc: PropertyNameExpected at line 17, column 23; InvalidSymbol at line 17, column 26; InvalidSymbol at line 17, column 34 (+1 more)',
    })
  })

  test('a plugin that throws at import: /config never answers; fail after the hang budget and name the plugins', async () => {
    const url = fakeOpencode({ '/config': () => new Promise<Response>(() => undefined) })
    const started = Date.now()
    const result = await provenCheck(url, Date.now() + 30_000, {
      directory: '/workspace',
      toolNames: [],
      pluginFiles: ['plugins/boom.ts'],
      requestTimeoutMs: 300,
      hangLimit: 3,
    })
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(result.ok).toBe(false)
    expect(result.ok ? '' : result.reason).toBe(
      'GET /config did not answer in 3 attempts; a plugin that fails at import stops the config load (plugins: plugins/boom.ts)',
    )
  })

  test('a tool that throws at import: a repeated 500 on /experimental/tool/ids fails with the error and the tool files', async () => {
    const url = fakeOpencode({
      '/config': () => Response.json({ default_agent: 'kortix' }),
      '/agent': () => Response.json([{ name: 'kortix', mode: 'primary' }]),
      '/experimental/tool/ids': () =>
        Response.json(
          { name: 'UnknownError', data: { message: 'Unexpected server error. Check server logs for details.', ref: 'err_a81809a9' } },
          { status: 500 },
        ),
    })
    const started = Date.now()
    const result = await provenCheck(url, Date.now() + 30_000, {
      directory: '/workspace',
      toolNames: ['broken_tool', 'scrape'],
      pollMs: 100,
    })
    expect(Date.now() - started).toBeLessThan(3_000)
    expect(result).toEqual({
      ok: false,
      fatal: true,
      reason:
        'tools failed to load: HTTP 500 UnknownError: Unexpected server error. Check server logs for details. (ref err_a81809a9) (tool files: tools/broken_tool.ts, tools/scrape.ts)',
    })
  })

  test('DEF-3c: the repeated 500 is recognised although every answer carries a new ref', async () => {
    // Re-verification 2026-09-22 on a real box: OpenCode answers each failed
    // /experimental/tool/ids with a NEW ref (err_38725039, err_4e007df1, ...).
    // The reason carried the ref, so "the same 5xx twice" never matched: the
    // check ran the full 90 s budget, and a deadline-cut /config request then
    // replaced the reason with "GET /config did not answer".
    let n = 0
    const url = fakeOpencode({
      '/config': () => Response.json({ default_agent: 'kortix' }),
      '/agent': () => Response.json([{ name: 'kortix', mode: 'primary' }]),
      '/experimental/tool/ids': () =>
        Response.json(
          {
            name: 'UnknownError',
            data: { message: 'Unexpected server error. Check server logs for details.', ref: `err_${(0x10000000 + n++).toString(16)}` },
          },
          { status: 500 },
        ),
    })
    const started = Date.now()
    const result = await provenCheck(url, Date.now() + 30_000, {
      directory: '/workspace',
      toolNames: ['broken_tool', 'scrape'],
      pollMs: 100,
    })
    expect(Date.now() - started).toBeLessThan(3_000)
    expect(result.ok).toBe(false)
    expect(result.ok ? null : result.fatal).toBe(true)
    const reason = result.ok ? '' : result.reason
    expect(reason.startsWith('tools failed to load: HTTP 500 UnknownError: Unexpected server error.')).toBe(true)
    expect(reason).toContain('(tool files: tools/broken_tool.ts, tools/scrape.ts)')
  })
})

// A tool file that answers 200 but registers no id for its own name is
// INDISTINGUISHABLE, from `/experimental/tool/ids`, from a genuinely missing
// tool file — the same class of failure the CFG-11/CFG-12 release-gate
// fixture hit (a `tools/hello.ts` shipping a bare `export default {}`; #7767).
// Measured on a real Platinum box 2026-09-26: a config-releases session with
// that shape gets `GET /experimental/tool/ids` 200 with every OTHER fixture
// tool's id but never `hello`; `running_release_id === desired_release_id`
// only once the file exports `{ description, args, execute }` (or a named
// export, registered as `<name>_<export>`). These two cases pin that
// contract at the unit level so a regression never again needs a live box to
// surface.
describe('provenCheck: a tool file that answers 200 but never registers', () => {
  test('is reported exactly like a missing tool, not silently accepted', async () => {
    const url = fakeOpencode({
      '/config': () => Response.json({ default_agent: 'kortix' }),
      '/agent': () => Response.json([{ name: 'kortix', mode: 'primary' }]),
      // Every OTHER fixture tool loaded; `hello` (a bare `export default {}`,
      // no execute) silently dropped — the exact shape of the real box result.
      '/experimental/tool/ids': () => Response.json(['scrape', 'memory', 'show']),
    })
    // A missing tool is not `fatal` (item 3's own comment: a missing
    // dependency does not stop OpenCode, so this keeps polling in case the
    // tool registers late) — a short deadline exits the retry loop instead
    // of waiting out the full budget.
    const result = await provenCheck(url, Date.now() + 200, {
      directory: '/workspace',
      toolNames: ['hello', 'scrape'],
      pollMs: 50,
    })
    expect(result).toEqual({ ok: false, reason: 'tools not loaded: hello' })
  })

  test('a default export registers under its own name; a named export registers <name>_<export>', async () => {
    const url = fakeOpencode({
      '/config': () => Response.json({ default_agent: 'kortix' }),
      '/agent': () => Response.json([{ name: 'kortix', mode: 'primary' }]),
      '/experimental/tool/ids': () => Response.json(['hello', 'multi_run', 'multi_check']),
    })
    const result = await provenCheck(url, Date.now() + 30_000, {
      directory: '/workspace',
      toolNames: ['hello', 'multi'],
      pollMs: 100,
    })
    expect(result).toEqual({ ok: true })
  })
})
