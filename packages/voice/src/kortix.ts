// The voice in a Kortix box. kortixd's built-in `kortix-voice` extension calls `attach` for each top-level session,
// and only while the project's `voice_call` flag is on: nothing here loads otherwise. One relay serves the box on
// KORTIX_VOICE_PORT (6902, beside the desktop's 6901), started with the first session. Each session binds itself under its Kortix session id,
// and a call names it (`/stream?session=<id>`); the browser reaches the port through the sandbox port proxy
// (`/v1/p/<sandbox>/<port>/stream?token=…`). A call's turns are that session's own turns (src/agents/pi.ts), so the
// conversation is the session's chat. The models come through the box's LLM proxy, which adds the box's token, and
// the searches through the Kortix API's billed router (src/models.ts). The session's agent gets the voice's meta tools
// (src/voice-tools.ts) for its own call.
import { fromExtension, type ContextLike, type ExtensionLike } from './agents/pi'
import * as brain from './brain'
import { callRelay, content, META_TOOLS, type Json } from './voice-tools'

/** What this uses of a pi ExtensionAPI: the adapter's events and messages, and tool registration. */
export type KortixPi = ExtensionLike & { registerTool(tool: object): void }

const PORT = () => Number(process.env.KORTIX_VOICE_PORT ?? 6902)
let relay: Promise<number> | undefined

/** The box's relay, started once: the gateway through the box's LLM proxy, else directly with the box's token. */
function start(): Promise<number> {
  if (!process.env.VOICE_MODELS_URL) {
    const proxy = process.env.KORTIX_LLM_PROXY_DISABLE !== '1' ? process.env.KORTIX_LLM_PROXY_URL?.trim() : undefined
    if (proxy) process.env.VOICE_MODELS_URL = proxy
    else if (process.env.KORTIX_LLM_BASE_URL && process.env.KORTIX_TOKEN) {
      process.env.VOICE_MODELS_URL = process.env.KORTIX_LLM_BASE_URL
      process.env.VOICE_MODELS_TOKEN = process.env.KORTIX_TOKEN
    }
  }
  return (relay ??= import('./server').then(({ serve }) => serve(PORT()).port as number))
}

/** The port the box's relay listens on, starting it if no session has yet. */
export const relayPort = (): Promise<number> => start()

/** Binds one session to the box's voice: its calls, and the meta tools its agent acts on them with. */
export function attach(pi: KortixPi, session: string): void {
  let ctx: ContextLike | undefined
  const agent = fromExtension(pi, () => ctx)
  brain.bind(session, agent)
  pi.on('session_start', (_event: unknown, c: ContextLike) => {
    ctx = c
    void start().catch((err) => console.error(`[voice] the relay did not start on ${PORT()}: ${(err as Error).message}`))
  })
  pi.on('session_shutdown', () => {
    brain.bind(session, undefined)
    agent.dispose()
  })
  for (const tool of META_TOOLS)
    pi.registerTool({
      name: tool.name,
      label: tool.label,
      description: tool.description,
      promptSnippet: tool.snippet,
      parameters: tool.parameters,
      async execute(_id: string, params: Json, signal?: AbortSignal) {
        const port = await start()
        const result = await callRelay({ url: `http://127.0.0.1:${port}`, token: process.env.VOICE_TOKEN, session }, tool, params ?? {}, signal)
        return { content: await content(result), details: result.data }
      },
    })
}
