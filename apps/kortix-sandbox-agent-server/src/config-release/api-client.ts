import {
  MAX_CONFIG_ARCHIVE_BYTES,
  parseConfigReleaseDescriptor,
  type ConfigReleaseDescriptor,
  type WorkspaceReport,
} from './descriptor'

/**
 * The two API calls a config release needs. Spec: docs/specs/config-releases.md,
 * "Routes" and "Download path".
 *
 * Both calls use the session's sandbox token as the bearer. The bearer goes to
 * the API origin only: the archive route may answer `302` to a signed storage
 * URL, and that URL receives no Authorization header.
 */

export const DESCRIPTOR_TIMEOUT_MS = 20_000
export const ARCHIVE_TIMEOUT_MS = 60_000

export interface ConfigReleaseApi {
  /** `KORTIX_API_URL`, with or without the `/v1` suffix. */
  apiUrl: string
  projectId: string
  sessionId: string
  /** The sandbox token (`KORTIX_TOKEN`). */
  token: string
  fetchImpl?: typeof fetch
}

/** `https://api.example.com/v1` → `https://api.example.com`. The `/v1` root is part of every API path. */
function apiOrigin(apiUrl: string): string {
  const trimmed = apiUrl.trim().replace(/\/+$/, '')
  return trimmed.endsWith('/v1') ? trimmed.slice(0, -'/v1'.length) : trimmed
}

/** Read the API settings from the daemon config. Null when any is missing. */
export function configReleaseApiFrom(input: {
  apiUrl?: string
  projectId?: string
  sandboxToken?: string
  sessionId?: string
}): ConfigReleaseApi | null {
  const apiUrl = input.apiUrl?.trim()
  const projectId = input.projectId?.trim()
  const token = input.sandboxToken?.trim()
  const sessionId = (input.sessionId ?? process.env.KORTIX_SESSION_ID)?.trim()
  if (!apiUrl || !projectId || !token || !sessionId) return null
  return { apiUrl, projectId, sessionId, token }
}

export class ConfigReleaseApiError extends Error {
  constructor(
    message: string,
    /** HTTP status when the API answered; null for a network or parse failure. */
    readonly status: number | null,
    /** The `code` field of a JSON error body, when the API sent one. */
    readonly code: string | null = null,
  ) {
    super(message)
    this.name = 'ConfigReleaseApiError'
  }
}

/** The API's code for a session from a previous repository generation. */
export const SESSION_REPOSITORY_CHANGED = 'session_repository_changed'

/**
 * The project replaced its repository after this session was created
 * (spec "Repository replacement"). The session is frozen on its running
 * config: no release applies, and this is not a failure.
 */
export function isRepositoryChangedError(err: unknown): err is ConfigReleaseApiError {
  return err instanceof ConfigReleaseApiError && err.status === 409 && err.code === SESSION_REPOSITORY_CHANGED
}

/** An error for a non-2xx answer, with the JSON body's `error` and `code` when present. */
async function errorFromResponse(res: Response, what: string): Promise<ConfigReleaseApiError> {
  const text = (await res.text().catch(() => '')).slice(0, 2_000)
  let code: string | null = null
  let message: string | null = null
  try {
    const body = JSON.parse(text) as { code?: unknown; error?: unknown }
    if (typeof body.code === 'string') code = body.code
    if (typeof body.error === 'string') message = body.error
  } catch {}
  if (code === SESSION_REPOSITORY_CHANGED && message) return new ConfigReleaseApiError(message, res.status, code)
  return new ConfigReleaseApiError(`${what} answered ${res.status}: ${text.slice(0, 300)}`, res.status, code)
}

/**
 * `POST /v1/projects/{projectId}/sessions/{sessionId}/config-release`.
 *
 * The response is validated in full before any field is used. An API that
 * predates the spec answers `404`; the caller keeps its current behaviour.
 */
export async function fetchConfigReleaseDescriptor(
  api: ConfigReleaseApi,
  workspace: WorkspaceReport | null,
  opts: { timeoutMs?: number } = {},
): Promise<ConfigReleaseDescriptor> {
  const fetchImpl = api.fetchImpl ?? fetch
  const url =
    `${apiOrigin(api.apiUrl)}/v1/projects/${encodeURIComponent(api.projectId)}` +
    `/sessions/${encodeURIComponent(api.sessionId)}/config-release`
  let res: Response
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${api.token}` },
      body: JSON.stringify({ workspace }),
      redirect: 'error',
      signal: AbortSignal.timeout(opts.timeoutMs ?? DESCRIPTOR_TIMEOUT_MS),
    })
  } catch (err) {
    throw new ConfigReleaseApiError(`descriptor request failed: ${(err as Error).message}`, null)
  }
  if (!res.ok) throw await errorFromResponse(res, 'descriptor request')
  let json: unknown
  try {
    json = await res.json()
  } catch (err) {
    throw new ConfigReleaseApiError(`descriptor is not JSON: ${(err as Error).message}`, res.status)
  }
  try {
    return parseConfigReleaseDescriptor(json)
  } catch (err) {
    throw new ConfigReleaseApiError((err as Error).message, res.status)
  }
}

/**
 * Download a config archive through the API. Returns the raw `tar.gz` bytes.
 *
 * - `archivePath` is the descriptor's `archive.url`, an API path. It resolves
 *   against the API origin only.
 * - At most one redirect. The redirect target gets no Authorization header: it
 *   is a signed storage URL, and the sandbox token must never reach storage.
 * - The body is capped at `maxBytes` while it streams. A larger body is refused
 *   before it is fully read.
 */
export async function downloadConfigArchive(
  api: ConfigReleaseApi,
  archivePath: string,
  opts: { maxBytes?: number; expectedBytes?: number; timeoutMs?: number } = {},
): Promise<Buffer> {
  const fetchImpl = api.fetchImpl ?? fetch
  const maxBytes = opts.maxBytes ?? MAX_CONFIG_ARCHIVE_BYTES
  const signal = AbortSignal.timeout(opts.timeoutMs ?? ARCHIVE_TIMEOUT_MS)
  const origin = apiOrigin(api.apiUrl)
  if (!archivePath.startsWith('/v1/')) throw new ConfigReleaseApiError('archive path is not an API path', null)
  const first = new URL(archivePath, `${origin}/`)
  if (first.origin !== new URL(origin).origin) {
    throw new ConfigReleaseApiError('archive path leaves the API origin', null)
  }

  const request = async (url: string, withAuth: boolean): Promise<Response> => {
    try {
      return await fetchImpl(url, {
        method: 'GET',
        headers: withAuth ? { Authorization: `Bearer ${api.token}` } : {},
        redirect: 'manual',
        signal,
      })
    } catch (err) {
      throw new ConfigReleaseApiError(`archive request failed: ${(err as Error).message}`, null)
    }
  }

  let res = await request(first.toString(), true)
  if (res.status >= 300 && res.status < 400) {
    const location = res.headers.get('location')
    void res.body?.cancel().catch(() => undefined)
    if (!location) throw new ConfigReleaseApiError(`archive redirect ${res.status} has no Location`, res.status)
    const target = new URL(location, first)
    if (target.protocol !== 'https:' && target.protocol !== 'http:') {
      throw new ConfigReleaseApiError('archive redirect has an unsupported scheme', res.status)
    }
    res = await request(target.toString(), false)
    if (res.status >= 300 && res.status < 400) {
      void res.body?.cancel().catch(() => undefined)
      throw new ConfigReleaseApiError('archive redirected more than once', res.status)
    }
  }
  if (!res.ok) throw await errorFromResponse(res, 'archive request')
  const declared = Number(res.headers.get('content-length') ?? NaN)
  if (Number.isFinite(declared) && declared > maxBytes) {
    void res.body?.cancel().catch(() => undefined)
    throw new ConfigReleaseApiError(`archive is ${declared} bytes; the limit is ${maxBytes}`, res.status)
  }

  const chunks: Buffer[] = []
  let total = 0
  const reader = res.body?.getReader()
  if (!reader) throw new ConfigReleaseApiError('archive response has no body', res.status)
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        // Not awaited: a cancel can wait on a producer that never ends.
        void reader.cancel().catch(() => undefined)
        throw new ConfigReleaseApiError(`archive exceeds the limit of ${maxBytes} bytes`, res.status)
      }
      chunks.push(Buffer.from(value))
    }
  } catch (err) {
    if (err instanceof ConfigReleaseApiError) throw err
    throw new ConfigReleaseApiError(`archive download failed: ${(err as Error).message}`, res.status)
  }
  const body = Buffer.concat(chunks)
  if (opts.expectedBytes !== undefined && body.length !== opts.expectedBytes) {
    throw new ConfigReleaseApiError(
      `archive is ${body.length} bytes; the descriptor says ${opts.expectedBytes}`,
      res.status,
    )
  }
  return body
}
