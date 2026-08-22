import { hostname, platform } from 'node:os'
import { spawn } from 'node:child_process'

const CODE = /^[A-Z]{4}-[0-9]{4}$/
const SECRET = /^[A-Za-z0-9]{32}$/

export interface NodeDeviceChallenge { device_code: string; device_secret: string; verification_url: string; expires_at: string; poll_interval_ms: number }

function safeBrowserUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048) throw new Error('Authorization server returned an invalid verification URL')
  const url = new URL(value)
  const loopback = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname)
  if (url.username || url.password || (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))) throw new Error('Authorization server returned an unsafe verification URL')
  return url.toString()
}

export function parseNodeDeviceChallenge(value: unknown): NodeDeviceChallenge {
  const input = value as Partial<NodeDeviceChallenge>
  if (!input || typeof input !== 'object' || !CODE.test(input.device_code ?? '') || !SECRET.test(input.device_secret ?? '')) throw new Error('Authorization server returned an invalid device challenge')
  const expires = Date.parse(input.expires_at ?? '')
  if (!Number.isFinite(expires) || expires <= Date.now() || expires > Date.now() + 10 * 60_000) throw new Error('Authorization server returned an invalid device expiration')
  if (!Number.isSafeInteger(input.poll_interval_ms) || input.poll_interval_ms! < 250 || input.poll_interval_ms! > 10_000) throw new Error('Authorization server returned an invalid poll interval')
  return { ...input, verification_url: safeBrowserUrl(input.verification_url) } as NodeDeviceChallenge
}

export async function requestNodeDeviceAuth(apiUrl: string): Promise<NodeDeviceChallenge> {
  const response = await fetch(`${apiUrl}/nodes/device-auth`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ machine_hostname: hostname(), type: 'workstation' }), signal: AbortSignal.timeout(15_000) })
  if (!response.ok) throw new Error(`Device authorization failed with ${response.status}`)
  return parseNodeDeviceChallenge(await response.json())
}

export async function pollNodeDeviceAuth(apiUrl: string, challenge: NodeDeviceChallenge, sleep = (ms: number) => Bun.sleep(ms)): Promise<{ enrollmentToken: string; signingPublicKey?: string }> {
  const deadline = Date.parse(challenge.expires_at)
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${apiUrl}/nodes/device-auth/${challenge.device_code}/status`, { headers: { authorization: `Bearer ${challenge.device_secret}` }, signal: AbortSignal.timeout(15_000) })
      if (response.ok) {
        const value = await response.json() as { status?: string; enrollment_token?: string; artifact_signing_public_key?: string | null }
        if (value.status === 'denied') throw new Error('Node enrollment was denied')
        if (value.status === 'expired') break
        if (value.status === 'approved' && value.enrollment_token) return { enrollmentToken: value.enrollment_token, ...(value.artifact_signing_public_key ? { signingPublicKey: value.artifact_signing_public_key } : {}) }
      }
    } catch (error) {
      if (error instanceof Error && /denied/.test(error.message)) throw error
    }
    await sleep(challenge.poll_interval_ms)
  }
  throw new Error('Node enrollment expired')
}

export function openNodeAuthorization(url: string): void {
  const safe = safeBrowserUrl(url)
  const command = platform() === 'darwin' ? ['open', safe] : platform() === 'win32' ? ['rundll32.exe', 'url.dll,FileProtocolHandler', safe] : ['xdg-open', safe]
  try { spawn(command[0]!, command.slice(1), { detached: true, stdio: 'ignore' }).unref() } catch {}
}
