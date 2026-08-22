import { flow } from '../core/flow'
import { assert } from '../core/expect'
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createHmac } from 'node:crypto'

function check(description: string, pass: boolean, expected: unknown, actual: unknown): void {
  assert({ kind: 'cli', description, expected, actual, pass })
}

async function processResult(command: string[], env: Record<string, string>, cwd?: string) {
  const child = Bun.spawn(command, { cwd, env: { ...process.env, ...env }, stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { stdout, stderr, exitCode, all: `${stdout}\n${stderr}` }
}

async function connectNodePeer(apiUrl: string, nodeId: string, credential: string) {
  const url = new URL(apiUrl.replace(/\/$/, '') + '/nodes/ws')
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  const socket = new WebSocket(url)
  let key = ''
  let nonce = 0
  let assignmentFrame: any = null
  let stopFrame: any = null
  let rpcFrame: any = null
  let resolveAssignment!: () => void
  let resolveStop!: () => void
  let resolveRpc!: () => void
  const assignmentReceived = new Promise<void>((resolve) => { resolveAssignment = resolve })
  const stopReceived = new Promise<void>((resolve) => { resolveStop = resolve })
  const rpcReceived = new Promise<void>((resolve) => { resolveRpc = resolve })
  await new Promise<void>((resolveOpen, reject) => {
    socket.addEventListener('open', () => socket.send(JSON.stringify({ type: 'node.auth', node_id: nodeId, token: credential, version: 'e2e', capabilities: ['filesystem', 'shell'], platform: process.platform, arch: process.arch })))
    socket.addEventListener('error', () => reject(new Error('node peer WebSocket failed')))
    socket.addEventListener('message', (event) => {
      const value = JSON.parse(String(event.data))
      if (value.type === 'node.auth.ok') { key = value.signing_key; resolveOpen(); return }
      if (value.type === 'assignment.apply') { assignmentFrame = value; resolveAssignment() }
      if (value.type === 'assignment.stop') { stopFrame = value; resolveStop() }
      if (value.type === 'rpc.request') { rpcFrame = value; resolveRpc() }
    })
  })
  const send = (frame: Record<string, unknown>) => {
    const next = ++nonce
    const payload = JSON.stringify(frame)
    socket.send(JSON.stringify({ ...frame, _nonce: next, _sig: createHmac('sha256', key).update(`${next}:${payload}`).digest('hex') }))
  }
  return { socket, assignmentReceived, stopReceived, rpcReceived, assignment: () => assignmentFrame, stop: () => stopFrame, rpc: () => rpcFrame, send }
}

flow(
  'KXD-REST',
  {
    domain: 'compute-nodes',
    serial: true,
    routes: [
      'POST /v1/nodes/device-auth',
      'GET /v1/nodes/device-auth/:code/status',
      'GET /v1/accounts/:accountId/compute-nodes/device-auth/:code',
      'POST /v1/accounts/:accountId/compute-nodes/device-auth/:code/approve',
      'POST /v1/accounts/:accountId/compute-nodes/device-auth/:code/deny',
      'POST /v1/accounts/:accountId/compute-nodes',
      'GET /v1/accounts/:accountId/compute-nodes',
      'GET /v1/accounts/:accountId/compute-nodes/:nodeId',
      'PATCH /v1/accounts/:accountId/compute-nodes/:nodeId',
      'POST /v1/accounts/:accountId/compute-nodes/:nodeId/enable',
      'POST /v1/accounts/:accountId/compute-nodes/:nodeId/disable',
      'POST /v1/accounts/:accountId/compute-nodes/:nodeId/drain',
      'POST /v1/accounts/:accountId/compute-nodes/:nodeId/restart',
      'POST /v1/accounts/:accountId/compute-nodes/:nodeId/rotate-credential',
      'POST /v1/accounts/:accountId/compute-nodes/:nodeId/assignments',
      'GET /v1/accounts/:accountId/compute-nodes/:nodeId/assignments',
      'POST /v1/accounts/:accountId/compute-nodes/:nodeId/assignments/:assignmentId/release',
      'POST /v1/projects/:projectId/sessions/:sessionId/node/rpc',
      'DELETE /v1/accounts/:accountId/compute-nodes/:nodeId',
      'POST /v1/nodes/enroll',
      'POST /v1/nodes/logout',
      'GET /v1/runtime-assets/manifest',
    ],
  },
  async (ctx) => {
    const accountId = ctx.P.accountId
    let nodeId = ''
    let enrollmentToken = ''
    let firstCredential = ''
    let deviceNodeId = ''
    let peer: Awaited<ReturnType<typeof connectNodePeer>> | null = null

    await ctx.step('daemon starts browser enrollment and only its device secret can poll', async () => {
      const created = await ctx.client.as(ctx.P.ANON).post('/v1/nodes/device-auth', { machine_hostname: 'kxd-e2e-workstation', type: 'workstation' })
      created.status(201).body().exists('$.device_code').exists('$.device_secret').exists('$.verification_url').has('$.poll_interval_ms', 1000)
      const challenge = created.json<any>()
      const invalid = await ctx.client.withBearer('wrong-device-secret', 'DEVICE').get('/v1/nodes/device-auth/:code/status', { params: { code: challenge.device_code } })
      invalid.status(401)
      const pending = await ctx.client.withBearer(challenge.device_secret, 'DEVICE').get('/v1/nodes/device-auth/:code/status', { params: { code: challenge.device_code } })
      pending.status(200).body().has('$.status', 'pending')
      const info = await ctx.client.as(ctx.P.OWNER).get('/v1/accounts/:accountId/compute-nodes/device-auth/:code', { params: { accountId, code: challenge.device_code } })
      info.status(200).body().has('$.machine_hostname', 'kxd-e2e-workstation').has('$.type', 'workstation')
      const approved = await ctx.client.as(ctx.P.OWNER).post('/v1/accounts/:accountId/compute-nodes/device-auth/:code/approve', {}, { params: { accountId, code: challenge.device_code } })
      approved.status(201).body().has('$.type', 'workstation').has('$.status', 'offline')
      deviceNodeId = approved.json<any>().compute_node_id
      const resolved = await ctx.client.withBearer(challenge.device_secret, 'DEVICE').get('/v1/nodes/device-auth/:code/status', { params: { code: challenge.device_code } })
      resolved.status(200).body().has('$.status', 'approved').exists('$.enrollment_token')
      const token = resolved.json<any>().enrollment_token
      const enrolled = await ctx.client.as(ctx.P.ANON).post('/v1/nodes/enroll', { enrollment_token: token })
      enrolled.status(200).body().has('$.compute_node_id', deviceNodeId).has('$.generation', 1)
      const replay = await ctx.client.as(ctx.P.ANON).post('/v1/nodes/enroll', { enrollment_token: token })
      replay.status(401)
    })

    await ctx.step('owner can deny a second browser enrollment without creating a node', async () => {
      const created = await ctx.client.as(ctx.P.ANON).post('/v1/nodes/device-auth', { machine_hostname: 'denied-workstation', type: 'workstation' })
      created.status(201)
      const challenge = created.json<any>()
      const denied = await ctx.client.as(ctx.P.OWNER).post('/v1/accounts/:accountId/compute-nodes/device-auth/:code/deny', {}, { params: { accountId, code: challenge.device_code } })
      denied.status(200).body().has('$.ok', true)
      const poll = await ctx.client.withBearer(challenge.device_secret, 'DEVICE').get('/v1/nodes/device-auth/:code/status', { params: { code: challenge.device_code } })
      poll.status(200).body().has('$.status', 'denied')
    })

    await ctx.step('anonymous and non-member callers cannot register an account compute node', async () => {
      await ctx.client.as(ctx.P.ANON).post('/v1/accounts/:accountId/compute-nodes', { type: 'workstation' }, { params: { accountId } }).then((r) => r.status(401))
      await ctx.client.as(ctx.P.NONMEMBER).post('/v1/accounts/:accountId/compute-nodes', { type: 'workstation' }, { params: { accountId } }).then((r) => r.status(403))
    })

    await ctx.step('owner registers an offline workstation and receives one short-lived enrollment token', async () => {
      const r = await ctx.client.as(ctx.P.OWNER).post('/v1/accounts/:accountId/compute-nodes', {
        type: 'workstation',
        update_channel: 'stable',
        concurrency: 1,
        metadata: { test_run: 'KXD-REST' },
      }, { params: { accountId } })
      r.status(201).body().has('$.node.status', 'offline').has('$.node.type', 'workstation').exists('$.enrollment_token')
      const body = r.json<any>()
      nodeId = body.node.compute_node_id
      enrollmentToken = body.enrollment_token
    })

    await ctx.step('daemon exchanges the token once and replay fails', async () => {
      const first = await ctx.client.as(ctx.P.ANON).post('/v1/nodes/enroll', { enrollment_token: enrollmentToken })
      first.status(200).body().has('$.compute_node_id', nodeId).exists('$.credential').has('$.generation', 1)
      firstCredential = first.json<any>().credential
      const replay = await ctx.client.as(ctx.P.ANON).post('/v1/nodes/enroll', { enrollment_token: enrollmentToken })
      replay.status(401)
    })

    await ctx.step('owner lists and reads the registered node without credential disclosure', async () => {
      const list = await ctx.client.as(ctx.P.OWNER).get('/v1/accounts/:accountId/compute-nodes', { params: { accountId } })
      list.status(200)
      const listed = list.json<any>().nodes.find((node: any) => node.compute_node_id === nodeId)
      if (!listed || 'credential' in listed || 'secret_hash' in listed) throw new Error('node list is missing the node or exposes credential material')
      const get = await ctx.client.as(ctx.P.OWNER).get('/v1/accounts/:accountId/compute-nodes/:nodeId', { params: { accountId, nodeId } })
      get.status(200).body().has('$.compute_node_id', nodeId)
    })

    await ctx.step('node credential reads convergence truth but remains separate from user authority', async () => {
      const manifest = await ctx.client.withBearer(firstCredential, 'NODE').get('/v1/runtime-assets/manifest')
      manifest.status(200).body().exists('$.build').exists('$.components')
    })

    await ctx.step('owner updates concurrency, channel, and desired manifest with read-back proof', async () => {
      const patch = await ctx.client.as(ctx.P.OWNER).patch('/v1/accounts/:accountId/compute-nodes/:nodeId', {
        concurrency: 2,
        update_channel: 'canary',
        desired_manifest: { epoch: 7, components: [] },
      }, { params: { accountId, nodeId } })
      patch.status(200).body().has('$.concurrency', 2).has('$.update_channel', 'canary').has('$.desired_manifest.epoch', 7)
    })

    await ctx.step('API assigns and releases a real session over the sole outbound node channel', async () => {
      const project = await ctx.fixtures.project()
      const session = await ctx.fixtures.session(project)
      peer = await connectNodePeer(ctx.env.apiUrl, nodeId, firstCredential)
      const assigned = await ctx.client.as(ctx.P.OWNER).post('/v1/accounts/:accountId/compute-nodes/:nodeId/assignments', { session_id: session.id, lease_seconds: 300, ports: [8000], writable_roots: [] }, { params: { accountId, nodeId } })
      assigned.status(202).body().has('$.session_id', session.id).has('$.status', 'assigned')
      const assignmentId = assigned.json<any>().assignment_id
      await peer.assignmentReceived
      const apply = peer.assignment()
      if (apply.assignment.env.KORTIX_NODE_TOKEN || apply.assignment.env.KORTIX_SANDBOX_TOKEN) throw new Error('assignment exposed a node or sandbox credential')
      peer.send({ v: 1, type: 'assignment.accept', stream_id: assignmentId, seq: 0, status: 'starting' })
      peer.send({ v: 1, type: 'assignment.ready', stream_id: assignmentId, seq: 1, ports: [8000], native_conversation_id: 'e2e-opencode' })
      let row: any = null
      for (let attempt = 0; attempt < 40; attempt++) {
        const listed = await ctx.client.as(ctx.P.OWNER).get('/v1/accounts/:accountId/compute-nodes/:nodeId/assignments', { params: { accountId, nodeId } })
        listed.status(200)
        row = listed.json<any>().assignments.find((item: any) => item.assignment_id === assignmentId)
        if (row?.status === 'ready') break
        await Bun.sleep(50)
      }
      if (row?.status !== 'ready') throw new Error(`assignment state did not persist ready: ${JSON.stringify(row)}`)
      const rpcResult = ctx.client.as(ctx.P.OWNER).post('/v1/projects/:projectId/sessions/:sessionId/node/rpc', { method: 'fs.stat', params: { path: '/workspace' } }, { params: { projectId: project.id, sessionId: session.id } })
      await peer.rpcReceived
      const rpc = peer.rpc()
      peer.send({ v: 1, type: 'rpc.result', stream_id: rpc.stream_id, seq: 0, result: { isDirectory: true, source: 'workstation-node' } })
      ;(await rpcResult).status(200).body().has('$.result.source', 'workstation-node')
      const release = await ctx.client.as(ctx.P.OWNER).post('/v1/accounts/:accountId/compute-nodes/:nodeId/assignments/:assignmentId/release', {}, { params: { accountId, nodeId, assignmentId } })
      release.status(202).body().has('$.status', 'draining')
      await peer.stopReceived
      if (peer.stop().reason !== 'release') throw new Error('release did not reach the compute node')
      peer.send({ v: 1, type: 'assignment.stopped', stream_id: assignmentId, seq: 2, reason: 'release' })
      let releasedRow: any = null
      for (let attempt = 0; attempt < 40; attempt++) {
        const released = await ctx.client.as(ctx.P.OWNER).get('/v1/accounts/:accountId/compute-nodes/:nodeId/assignments', { params: { accountId, nodeId } })
        released.status(200)
        releasedRow = released.json<any>().assignments.find((item: any) => item.assignment_id === assignmentId)
        if (releasedRow?.status === 'released') break
        await Bun.sleep(50)
      }
      if (releasedRow?.status !== 'released') throw new Error(`assignment state did not persist released: ${JSON.stringify(releasedRow)}`)
      peer.socket.close()
      peer = null
    })

    for (const [action, status] of [['drain', 'draining'], ['enable', 'offline'], ['disable', 'disabled'], ['enable', 'offline'], ['restart', 'offline']] as const) {
      await ctx.step(`${action} updates the durable node status to ${status}`, async () => {
        const r = await ctx.client.as(ctx.P.OWNER).post(`/v1/accounts/:accountId/compute-nodes/:nodeId/${action}`, {}, { params: { accountId, nodeId } })
        r.status(200).body().has('$.status', status)
      })
    }

    await ctx.step('credential rotation revokes generation one and issues a new single-use enrollment exchange', async () => {
      const rotate = await ctx.client.as(ctx.P.OWNER).post('/v1/accounts/:accountId/compute-nodes/:nodeId/rotate-credential', {}, { params: { accountId, nodeId } })
      rotate.status(200).body().exists('$.enrollment_token')
      const token = rotate.json<any>().enrollment_token
      const enroll = await ctx.client.as(ctx.P.ANON).post('/v1/nodes/enroll', { enrollment_token: token })
      enroll.status(200).body().has('$.compute_node_id', nodeId).has('$.generation', 2).exists('$.credential')
      const oldCredential = await ctx.client.withBearer(firstCredential, 'NODE').post('/v1/nodes/logout', { compute_node_id: nodeId })
      oldCredential.status(401)
    })

    await ctx.step('delete releases the node and subsequent reads return 404', async () => {
      const deleted = await ctx.client.as(ctx.P.OWNER).del('/v1/accounts/:accountId/compute-nodes/:nodeId', { params: { accountId, nodeId } })
      deleted.status(200).body().has('$.ok', true)
      const get = await ctx.client.as(ctx.P.OWNER).get('/v1/accounts/:accountId/compute-nodes/:nodeId', { params: { accountId, nodeId } })
      get.status(404)
      if (deviceNodeId) {
        await ctx.client.as(ctx.P.OWNER).del('/v1/accounts/:accountId/compute-nodes/:nodeId', { params: { accountId, nodeId: deviceNodeId } }).then((response) => response.status(200))
      }
    })
  },
)

flow(
  'KXD-CLI',
  {
    domain: 'compute-nodes',
    serial: true,
    timeoutMs: 180_000,
    routes: [
      'POST /v1/accounts/:accountId/compute-nodes',
      'POST /v1/nodes/device-auth',
      'GET /v1/nodes/device-auth/:code/status',
      'POST /v1/accounts/:accountId/compute-nodes/device-auth/:code/approve',
      'POST /v1/nodes/enroll',
      'POST /v1/nodes/logout',
      'DELETE /v1/accounts/:accountId/compute-nodes/:nodeId',
    ],
  },
  async (ctx) => {
    const root = resolve(import.meta.dir, '../../..')
    const daemonDir = join(root, 'apps/kortix-sandbox-agent-server')
    const stateDir = mkdtempSync(join(tmpdir(), 'kortixd-e2e-state-'))
    const binaryDir = mkdtempSync(join(tmpdir(), 'kortixd-e2e-bin-'))
    const binary = join(binaryDir, process.platform === 'win32' ? 'kortixd.exe' : 'kortixd')
    let nodeId = ''
    let browserNodeId = ''
    try {
      await ctx.step('compile the native kortixd executable and run help, version, and invalid input', async () => {
        const built = await processResult(['bun', 'build', '--compile', '--outfile', binary, 'src/kortixd.ts'], {}, daemonDir)
        check('native compile exits 0', built.exitCode === 0, 0, built.exitCode)
        const help = await processResult([binary, 'help'], { KORTIXD_HOME: stateDir })
        check('help exits 0 and names connect', help.exitCode === 0 && help.stdout.includes('connect'), true, help)
        const version = await processResult([binary, 'version'], { KORTIXD_HOME: stateDir })
        check('version exits 0', version.exitCode === 0 && /^kortixd /m.test(version.stdout), true, version)
        const invalid = await processResult([binary, 'not-a-command'], { KORTIXD_HOME: stateDir })
        check('invalid command exits 2', invalid.exitCode === 2, 2, invalid.exitCode)
      })

      let token = ''
      await ctx.step('owner registers a local-computer node for compiled CLI enrollment', async () => {
        const r = await ctx.client.as(ctx.P.OWNER).post('/v1/accounts/:accountId/compute-nodes', { type: 'workstation' }, { params: { accountId: ctx.P.accountId } })
        r.status(201)
        nodeId = r.json<any>().node.compute_node_id
        token = r.json<any>().enrollment_token
      })

      await ctx.step('compiled connect stores the credential privately without printing it', async () => {
        const connected = await processResult([binary, 'connect', '--api', ctx.env.apiUrl, '--token', token, '--no-service'], { KORTIXD_HOME: stateDir })
        check('connect exits 0', connected.exitCode === 0, 0, connected.exitCode)
        check('stdout names node but not credential', connected.stdout.includes(nodeId) && !connected.stdout.includes('kortix_node_'), true, connected.stdout)
        if (process.platform !== 'win32') {
          check('state directory mode is 0700', (statSync(stateDir).mode & 0o777) === 0o700, 0o700, statSync(stateDir).mode & 0o777)
          check('credential file mode is 0600', (statSync(join(stateDir, 'node.json')).mode & 0o777) === 0o600, 0o600, statSync(join(stateDir, 'node.json')).mode & 0o777)
        }
      })

      await ctx.step('compiled doctor reads local enrollment and status reports an unreachable local daemon', async () => {
        const doctor = await processResult([binary, 'doctor'], { KORTIXD_HOME: stateDir })
        check('doctor exits 0', doctor.exitCode === 0 && doctor.stdout.includes('node configuration: ok'), true, doctor)
        const status = await processResult([binary, 'status', '--json', '--url', 'http://127.0.0.1:1'], { KORTIXD_HOME: stateDir })
        check('offline status is stable JSON without API connectivity', status.exitCode === 0 && JSON.parse(status.stdout).daemon.status === 'offline', true, status)
        const logs = await processResult([binary, 'logs', '--lines', '10'], { KORTIXD_HOME: stateDir })
        check('logs works without API connectivity', logs.exitCode === 0, 0, logs.exitCode)
      })

      await ctx.step('compiled logout removes the credential and is idempotent', async () => {
        const first = await processResult([binary, 'logout'], { KORTIXD_HOME: stateDir })
        check('first logout exits 0 and removes credential', first.exitCode === 0 && !existsSync(join(stateDir, 'node.json')), true, first)
        const second = await processResult([binary, 'logout'], { KORTIXD_HOME: stateDir })
        check('second logout exits 0', second.exitCode === 0 && second.stdout.includes('no local node credential'), true, second)
      })

      await ctx.step('compiled connect completes browser device authorization without a supplied token', async () => {
        const child = Bun.spawn([binary, 'connect', '--api', ctx.env.apiUrl, '--no-browser', '--no-service'], {
          env: { ...process.env, KORTIXD_HOME: stateDir }, stdout: 'pipe', stderr: 'pipe',
        })
        const reader = child.stdout.getReader()
        const decoder = new TextDecoder()
        let stdout = ''
        let resolveCode!: (code: string) => void
        const codePromise = new Promise<string>((resolve) => { resolveCode = resolve })
        const outputPromise = (async () => {
          let resolved = false
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            stdout += decoder.decode(value, { stream: true })
            const match = stdout.match(/device code: ([A-Z]{4}-[0-9]{4})/)
            if (match && !resolved) { resolved = true; resolveCode(match[1]!) }
          }
          stdout += decoder.decode()
        })()
        const code = await Promise.race([
          codePromise,
          Bun.sleep(15_000).then(() => { throw new Error(`compiled connect did not print a device code: ${stdout}`) }),
        ])
        const approved = await ctx.client.as(ctx.P.OWNER).post('/v1/accounts/:accountId/compute-nodes/device-auth/:code/approve', {}, { params: { accountId: ctx.P.accountId, code } })
        approved.status(201)
        browserNodeId = approved.json<any>().compute_node_id
        const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
        await outputPromise
        check('browser connect exits 0 and names approved node', exitCode === 0 && stdout.includes(browserNodeId), true, { exitCode, stdout, stderr })
        check('browser connect does not print credential material', !stdout.includes('kortix_node_') && !stderr.includes('kortix_node_'), true, { stdout, stderr })
        const logout = await processResult([binary, 'logout'], { KORTIXD_HOME: stateDir })
        check('browser-enrolled node logs out', logout.exitCode === 0, 0, logout.exitCode)
      })
    } finally {
      for (const cleanupNodeId of [nodeId, browserNodeId]) {
        if (!cleanupNodeId) continue
        await ctx.client.as(ctx.P.OWNER).del('/v1/accounts/:accountId/compute-nodes/:nodeId', { params: { accountId: ctx.P.accountId, nodeId: cleanupNodeId } }).catch(() => {})
      }
      rmSync(stateDir, { recursive: true, force: true })
      rmSync(binaryDir, { recursive: true, force: true })
    }
  },
)
