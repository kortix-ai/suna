/**
 * `/kortix/env` answers 200 only after the daemon's /event subscription is live
 * on the OpenCode process a RESTART reload just promoted — bounded.
 *
 * The control plane forwards the prompt the instant this route answers. A
 * verified reload promotes a new process on the other port and kills the old
 * one; the event loop re-subscribes ~100ms after it notices the drop. Answering
 * before that lets a short turn start and finish with nobody subscribed to its
 * `session.idle` (live 2026-08-23, session eddd499a: 80+s "Gathering thoughts"
 * on a 5s answer). This is the mid-session twin of main.ts's boot-time
 * "subscribe before prompt" rule.
 */
import { afterAll, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Config } from '../config'
import type { Opencode } from '../opencode'
import { createProjectEnvStore } from '../project-env'
import { createEnvRouter } from '../routes/env'
import { createEventSubscriptionState } from '../event-subscription'

const TEST_TOKEN = 'resubscribe-test-kortix-token-32-chars'
const TEST_ENV_DIR = mkdtempSync(join(tmpdir(), 'kortix-env-resubscribe-'))
let seq = 0
afterAll(() => rmSync(TEST_ENV_DIR, { recursive: true, force: true }))

const OLD_URL = 'http://127.0.0.1:4096'
const NEW_URL = 'http://127.0.0.1:4097'

function baseConfig(): Config {
  return {
    servicePort: 8000,
    opencodeInternalPort: 4096,
    opencodeStandbyPort: 4097,
    staticPort: 3211,
    workspace: '/workspace',
    projectTarget: '/workspace',
    defaultBranch: 'main',
    branchFetchAttempts: 60,
    branchFetchDelaySec: 0.25,
    defaultOpencodeConfigDir: '/ephemeral/opencode',
    autoClone: false,
    projectId: 'project-1',
    apiUrl: 'http://api.test/v1',
    repoUrl: undefined,
    branchName: undefined,
    sessionFresh: false,
    baseSha: undefined,
    sandboxToken: TEST_TOKEN,
    gitUserName: 'Kortix Agent',
    gitUserEmail: 'agent@kortix.ai',
    cloneFilter: '',
    cloneDepth: 1,
    workload: '',
    monitorsJson: '',
    monitorBoxEpoch: '',
  }
}

function fakeOpencode(how: 'restarted' | 'disposed') {
  let url = OLD_URL
  const opencode = {
    getState: () => 'ok' as const,
    getPid: () => 123,
    getInternalUrl: () => url,
    reloadConfig: async () => {
      // A verified swap promotes the candidate on the other port BEFORE it
      // returns; the env route must key its wait on the promoted URL.
      if (how === 'restarted') url = NEW_URL
      return { how, turnEnded: false }
    },
  } as unknown as Opencode
  return opencode
}

function store() {
  return createProjectEnvStore({
    KORTIX_PROJECT_SECRETS_REVISION: 'rev-1',
    KORTIX_PROJECT_SECRET_NAMES: 'API_KEY',
    API_KEY: 'v1',
  } as NodeJS.ProcessEnv)
}

async function postEnv(router: ReturnType<typeof createEnvRouter>) {
  const res = await router.request('/', {
    method: 'POST',
    headers: { Authorization: `Bearer ${TEST_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ revision: 'rev-2', env: { API_KEY: 'v2' }, names: ['API_KEY'], refreshModels: true }),
  })
  return { status: res.status, json: (await res.json()) as Record<string, unknown> }
}

describe('env route — a reload (restart OR dispose) waits (bounded) for the /event re-subscribe on the serving process', () => {
  it('answers 200 with event_subscription_live:true as soon as the loop is live on the NEW url', async () => {
    const subscription = createEventSubscriptionState()
    subscription.markLive(OLD_URL) // subscribed to the process about to be retired
    const router = createEnvRouter(baseConfig(), fakeOpencode('restarted'), store(), {
      agentEnvFile: join(TEST_ENV_DIR, `agent-env-${seq++}.sh`),
      eventSubscription: subscription,
      eventResubscribeWaitMs: 1_500,
    })
    // The loop re-subscribes to the promoted process 60ms after the swap.
    setTimeout(() => subscription.markLive(NEW_URL), 60)
    const started = Date.now()
    const { status, json } = await postEnv(router)
    const elapsed = Date.now() - started
    expect(status).toBe(200)
    expect(json.opencode_reload).toBe('restarted')
    expect(json.event_subscription_live).toBe(true)
    expect(elapsed).toBeGreaterThanOrEqual(50)
    expect(elapsed).toBeLessThan(1_000)
  })

  it('gives up after the bound and still answers 200 with event_subscription_live:false', async () => {
    const subscription = createEventSubscriptionState()
    subscription.markLive(OLD_URL) // stale: never re-subscribes in this test
    const router = createEnvRouter(baseConfig(), fakeOpencode('restarted'), store(), {
      agentEnvFile: join(TEST_ENV_DIR, `agent-env-${seq++}.sh`),
      eventSubscription: subscription,
      eventResubscribeWaitMs: 120,
    })
    const started = Date.now()
    const { status, json } = await postEnv(router)
    expect(status).toBe(200)
    expect(json.event_subscription_live).toBe(false)
    expect(Date.now() - started).toBeGreaterThanOrEqual(110)
  })

  it('a dispose reload closes the stream too: waits for a NEW subscription on the same url', async () => {
    // Verified live 2026-08-23: POST /global/dispose emits server.instance.disposed
    // and ends every open /event stream. The process and port are unchanged, so
    // a URL-keyed liveness check would read the closing subscription as live.
    const subscription = createEventSubscriptionState()
    subscription.markLive(OLD_URL)
    const router = createEnvRouter(baseConfig(), fakeOpencode('disposed'), store(), {
      agentEnvFile: join(TEST_ENV_DIR, `agent-env-${seq++}.sh`),
      eventSubscription: subscription,
      eventResubscribeWaitMs: 1_500,
    })
    setTimeout(() => {
      subscription.markDropped()
      subscription.markLive(OLD_URL)
    }, 60)
    const started = Date.now()
    const { status, json } = await postEnv(router)
    const elapsed = Date.now() - started
    expect(status).toBe(200)
    expect(json.opencode_reload).toBe('disposed')
    expect(json.event_subscription_live).toBe(true)
    expect(elapsed).toBeGreaterThanOrEqual(50)
    expect(elapsed).toBeLessThan(1_000)
  })

  it('a dispose reload whose stream never re-subscribes answers event_subscription_live:false after the bound', async () => {
    const subscription = createEventSubscriptionState()
    subscription.markLive(OLD_URL) // the subscription the dispose is closing; nothing replaces it
    const router = createEnvRouter(baseConfig(), fakeOpencode('disposed'), store(), {
      agentEnvFile: join(TEST_ENV_DIR, `agent-env-${seq++}.sh`),
      eventSubscription: subscription,
      eventResubscribeWaitMs: 120,
    })
    const started = Date.now()
    const { status, json } = await postEnv(router)
    expect(status).toBe(200)
    expect(json.event_subscription_live).toBe(false)
    expect(Date.now() - started).toBeGreaterThanOrEqual(110)
  })
})
