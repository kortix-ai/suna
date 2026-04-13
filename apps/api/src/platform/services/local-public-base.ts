import { execSync, spawn } from 'child_process'

type NgrokTunnel = {
  name: string
  public_url: string
  proto: string
  config?: { addr?: string }
}

const NGROK_API_PORTS = [4040, 4041, 4042]
const LOCAL_SHARE_TUNNEL_NAME = 'kortix-share'

function isNgrokInstalled(): boolean {
  try {
    execSync('which ngrok', { stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

async function probeNgrokApi(apiPort: number): Promise<{ tunnels: NgrokTunnel[]; apiPort: number } | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${apiPort}/api/tunnels`, {
      signal: AbortSignal.timeout(2000),
    })
    if (!res.ok) return null
    const data = await res.json() as { tunnels: NgrokTunnel[] }
    return { tunnels: data.tunnels, apiPort }
  } catch {
    return null
  }
}

async function findNgrokAgent(): Promise<{ tunnels: NgrokTunnel[]; apiPort: number } | null> {
  const results = await Promise.all(NGROK_API_PORTS.map(probeNgrokApi))
  return results.find((r): r is NonNullable<typeof r> => r !== null) ?? null
}

function findTunnelForPort(tunnels: NgrokTunnel[], port: number): NgrokTunnel | undefined {
  return tunnels.find((t) => {
    const addr = t.config?.addr || ''
    const match = addr.match(/:(\d+)$/)
    return match && Number(match[1]) === port
  })
}

export function getHostPortFromBaseUrl(resolvedBaseUrl: string): number {
  try {
    const parsed = new URL(resolvedBaseUrl)
    return Number(parsed.port || '14000')
  } catch {
    return 14000
  }
}

export async function ensureLocalTunnel(hostPort: number): Promise<string> {
  const agent = await findNgrokAgent()

  if (agent) {
    const existing = findTunnelForPort(agent.tunnels, hostPort)
    if (existing) return existing.public_url.replace(/\/+$/, '')

    const res = await fetch(`http://127.0.0.1:${agent.apiPort}/api/tunnels`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: LOCAL_SHARE_TUNNEL_NAME, proto: 'http', addr: String(hostPort) }),
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`Failed to add ngrok tunnel (${res.status}): ${text.slice(0, 300)}`)
    }
    const created = await res.json() as NgrokTunnel
    return created.public_url.replace(/\/+$/, '')
  }

  if (!isNgrokInstalled()) {
    throw new Error('ngrok is not installed')
  }

  const ngrokProc = spawn('ngrok', ['http', String(hostPort)], {
    stdio: 'ignore',
    detached: true,
  })
  ngrokProc.unref()

  for (let i = 0; i < 25; i += 1) {
    const found = await findNgrokAgent()
    const tunnel = found ? findTunnelForPort(found.tunnels, hostPort) : null
    if (tunnel) return tunnel.public_url.replace(/\/+$/, '')
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }

  throw new Error(`ngrok tunnel for port ${hostPort} was not detected in time`)
}

export async function syncSandboxPublicBase(resolvedBaseUrl: string, serviceKey: string, publicBaseUrl: string): Promise<void> {
  if (!serviceKey) throw new Error('Missing sandbox service key for PUBLIC_BASE_URL sync')
  const res = await fetch(`${resolvedBaseUrl}/env`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${serviceKey}`,
    },
    body: JSON.stringify({ keys: { PUBLIC_BASE_URL: publicBaseUrl } }),
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Failed to sync PUBLIC_BASE_URL (${res.status}): ${text.slice(0, 300)}`)
  }
}

export async function ensureLocalSandboxPublicBase(resolvedBaseUrl: string, serviceKey: string): Promise<string> {
  const hostPort = getHostPortFromBaseUrl(resolvedBaseUrl)
  const publicBaseUrl = await ensureLocalTunnel(hostPort)
  await syncSandboxPublicBase(resolvedBaseUrl, serviceKey, publicBaseUrl)
  return publicBaseUrl
}
