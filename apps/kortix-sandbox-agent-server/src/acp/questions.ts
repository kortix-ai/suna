import { AcpProtocolError, type AcpConnection, type JsonRpcEnvelope } from './connection'

export interface OpenCodeQuestionRequest {
  id: string
  sessionID: string
  questions: unknown[]
}

type ClientRequestConnection = Pick<AcpConnection, 'requestClient'>
type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function questionAnswers(value: unknown): string[][] | null {
  if (!Array.isArray(value)) return null
  const answers = value.map((answer) => (Array.isArray(answer) && answer.every((item) => typeof item === 'string') ? answer : null))
  return answers.every((answer): answer is string[] => answer !== null) ? answers : null
}

export function publishQuestionRequest(
  connection: ClientRequestConnection,
  request: OpenCodeQuestionRequest,
  handle: (response: JsonRpcEnvelope) => Promise<void>,
): void {
  connection.requestClient(
    'session/request_input',
    {
      sessionId: request.sessionID,
      questions: request.questions,
    },
    `kortix:question:${request.id}`,
    handle,
    { timeoutMs: null },
  )
}

export function createQuestionResponseHandler(options: {
  baseUrl: string
  workspace: string
  requestId: string
  fetch?: Fetch
}): (response: JsonRpcEnvelope) => Promise<void> {
  const fetcher = options.fetch ?? fetch
  return async (response) => {
    if (!('result' in response) || !isObject(response.result)) {
      throw new AcpProtocolError('ACP question response must contain a result')
    }
    const action = response.result.action
    const query = `directory=${encodeURIComponent(options.workspace)}`
    let url: string
    let body: string | undefined

    if (action === 'decline' || action === 'cancel') {
      url = `${options.baseUrl}/question/${encodeURIComponent(options.requestId)}/reject?${query}`
    } else if (action === 'accept') {
      const content = isObject(response.result.content) ? response.result.content : {}
      const answers = questionAnswers(content.answers)
      if (!answers) {
        throw new AcpProtocolError('ACP question response contains invalid answers')
      }
      url = `${options.baseUrl}/question/${encodeURIComponent(options.requestId)}/reply?${query}`
      body = JSON.stringify({ answers })
    } else {
      throw new AcpProtocolError('ACP question response contains an invalid action')
    }

    const result = await fetcher(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      ...(body ? { body } : {}),
      signal: AbortSignal.timeout(15_000),
    })
    if (!result.ok) {
      throw new AcpProtocolError(`OpenCode question response failed: ${result.status} ${(await result.text()).slice(0, 300)}`)
    }
  }
}
